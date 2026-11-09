// Artifact transfer between trial computers and scoring computers (plan.md: "Artifact transfer").
//
// Trial outputs go to our S3 bucket (Vultr Object Storage in production, MinIO in tests) through
// presigned URLs under `runs/<run>/trials/<trial>/`. The orchestrator holds the S3 credentials and
// hands out short-lived URLs; computers only ever see URLs, never keys.
//
// Flow:
//   1. The trial computer reports a file's size and sha256.
//   2. The orchestrator calls `ArtifactStore.createUpload`, which enforces the size cap and returns an
//      `UploadPlan`: one presigned PUT, or (over 100 MiB) a multipart upload with one presigned PUT per part.
//   3. The trial computer runs the plan (`uploadFileWithPlan`, or curl against the same URLs and headers).
//   4. The orchestrator calls `ArtifactStore.completeUpload`, which checks the stored size against the plan
//      and returns the recorded sha256.
//   5. A scoring computer gets a presigned GET from `ArtifactStore.createDownload` and fetches it with
//      `downloadToFile`, which refuses the file unless its sha256 matches the one recorded at upload.
//
// The content length is signed into every PUT URL, so a URL cannot be used to store more (or fewer)
// bytes than were declared. The sha256 is recorded as object metadata (`x-amz-meta-sha256`).

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
  type Part,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

export const MIB = 1024 * 1024;
/** Files strictly larger than this go up as a multipart upload. */
export const MULTIPART_THRESHOLD_BYTES = 100 * MIB;
/** Default part size for multipart uploads. */
export const DEFAULT_PART_BYTES = 16 * MIB;
/** S3 minimum part size (every part except the last). */
export const MIN_PART_BYTES = 5 * MIB;
/** S3 maximum part count. */
export const MAX_PARTS = 10_000;
/** Longest presigned URL lifetime SigV4 allows. */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_PRESIGN_SECONDS = 60 * 60;
/** Metadata key the sha256 is recorded under (sent as `x-amz-meta-sha256`). */
export const SHA256_METADATA_KEY = "sha256";
const SHA256_HEADER = `x-amz-meta-${SHA256_METADATA_KEY}`;
/**
 * S3 flexible checksum: the store itself verifies the body against it and rejects a mismatch
 * (BadDigest), so an uploader can't declare one sha256 and send other bytes of the same size
 * (TDM-51). Signed and unhoisted, so it must be sent as this header with this value.
 */
const CHECKSUM_SHA256_HEADER = "x-amz-checksum-sha256";

function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

// ---------------------------------------------------------------------------------------------
// Errors

export type ArtifactTransferErrorCode =
  "too_large" | "size_mismatch" | "checksum_mismatch" | "not_found" | "http_error" | "config";

export class ArtifactTransferError extends Error {
  readonly code: ArtifactTransferErrorCode;
  constructor(code: ArtifactTransferErrorCode, message: string) {
    super(message);
    this.name = "ArtifactTransferError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Config

export const s3ConfigSchema = z.object({
  endpoint: z.url(),
  region: z.string().min(1),
  bucket: z.string().min(3).max(63),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  /** Vultr Object Storage and MinIO want path-style addressing. */
  forcePathStyle: z.boolean().default(true),
});
export type S3ConfigInput = z.input<typeof s3ConfigSchema>;
export type S3Config = z.output<typeof s3ConfigSchema>;

const S3_ENV_VARS = {
  endpoint: "S3_ENDPOINT",
  region: "S3_REGION",
  bucket: "S3_BUCKET",
  accessKeyId: "S3_ACCESS_KEY_ID",
  secretAccessKey: "S3_SECRET_ACCESS_KEY",
} as const;

/** Reads S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY. Never echoes values. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
  const raw = Object.fromEntries(
    Object.entries(S3_ENV_VARS).map(([field, name]) => [field, env[name] || undefined]),
  );
  const parsed = s3ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const bad = parsed.error.issues.map((issue) => {
      const field = String(issue.path[0]) as keyof typeof S3_ENV_VARS;
      return S3_ENV_VARS[field] ?? field;
    });
    throw new ArtifactTransferError(
      "config",
      `S3 config invalid or missing: ${[...new Set(bad)].join(", ")}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Keys

/** A run or trial id: one safe path segment. */
export const artifactIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "id must be 1-128 chars of [A-Za-z0-9._-], not starting with . _ or -",
  );

/** An artifact name relative to the trial prefix, e.g. `out/scrollback.txt`. No `..`, no leading `/`. */
export const artifactNameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (name) =>
      name.split("/").every((seg) => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== "." && seg !== ".."),
    "name must be /-separated segments of [A-Za-z0-9._-], without . or .. segments",
  );

export function trialPrefix(runId: string, trialId: string): string {
  return `runs/${artifactIdSchema.parse(runId)}/trials/${artifactIdSchema.parse(trialId)}/`;
}

export function trialArtifactKey(runId: string, trialId: string, name: string): string {
  return trialPrefix(runId, trialId) + artifactNameSchema.parse(name);
}

/**
 * Server-owned artifacts of a run (e.g. trial traces): `runs/<run>/server/<name>`. Outside every
 * trial prefix, so no runner upload (always under `runs/<run>/trials/<trial>/`) can write one.
 */
export function serverArtifactKey(runId: string, name: string): string {
  return `runs/${artifactIdSchema.parse(runId)}/server/${artifactNameSchema.parse(name)}`;
}

/**
 * TDM-217 [19.1]: a user's kit tarball as uploaded (untrusted, written by a presigned PUT):
 * `kits/uploads/<owner>/<upload>.tar.gz`. The owner is in the key, so completing an upload id
 * looks only under the caller's own prefix.
 */
export function kitUploadKey(ownerId: string, uploadId: string): string {
  return `kits/uploads/${artifactIdSchema.parse(ownerId)}/${artifactIdSchema.parse(uploadId)}.tar.gz`;
}

/**
 * TDM-217 [19.1]: a validated kit's tarball, written by the server only:
 * `kits/files/<owner>/<kit>.tar.gz`. No presigned PUT is ever made for this prefix.
 */
export function kitFilesKey(ownerId: string, kitId: string): string {
  return `kits/files/${artifactIdSchema.parse(ownerId)}/${artifactIdSchema.parse(kitId)}.tar.gz`;
}

const KIT_FILES_KEY_RE =
  /^kits\/files\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/;

// ---------------------------------------------------------------------------------------------
// Plans (these cross the orchestrator → computer boundary, so they have schemas)

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars");
const byteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const uploadPartSchema = z.object({
  partNumber: z.number().int().min(1).max(MAX_PARTS),
  offset: byteCountSchema,
  sizeBytes: byteCountSchema,
  url: z.url(),
  headers: z.record(z.string(), z.string()),
});
export type UploadPart = z.infer<typeof uploadPartSchema>;

const planBase = {
  key: z.string().min(1),
  sizeBytes: byteCountSchema,
  sha256: sha256Schema,
  maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.iso.datetime(),
};

export const uploadPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single"),
    ...planBase,
    method: z.literal("PUT"),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal("multipart"),
    ...planBase,
    uploadId: z.string().min(1),
    partSizeBytes: z.number().int().min(MIN_PART_BYTES),
    parts: z.array(uploadPartSchema).min(1).max(MAX_PARTS),
  }),
]);
export type UploadPlan = z.infer<typeof uploadPlanSchema>;

export const createUploadRequestSchema = z.object({
  runId: artifactIdSchema,
  trialId: artifactIdSchema,
  name: artifactNameSchema,
  sizeBytes: byteCountSchema,
  sha256: sha256Schema,
  /** Size cap in bytes (from the kit's `transfer.max_mb`, converted by the caller). */
  maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresInSec: z.number().int().min(1).max(MAX_PRESIGN_SECONDS).default(DEFAULT_PRESIGN_SECONDS),
  /** Override the multipart part size (min 5 MiB). */
  partSizeBytes: z.number().int().min(MIN_PART_BYTES).optional(),
});
export type CreateUploadRequest = z.input<typeof createUploadRequestSchema>;

export const createDownloadRequestSchema = z.object({
  runId: artifactIdSchema,
  trialId: artifactIdSchema,
  name: artifactNameSchema,
  expiresInSec: z.number().int().min(1).max(MAX_PRESIGN_SECONDS).default(DEFAULT_PRESIGN_SECONDS),
});
export type CreateDownloadRequest = z.input<typeof createDownloadRequestSchema>;

export const downloadTicketSchema = z.object({
  key: z.string().min(1),
  url: z.url(),
  sizeBytes: byteCountSchema,
  /** Recorded at upload; `downloadToFile` refuses the file if it does not match. */
  sha256: sha256Schema,
  expiresAt: z.iso.datetime(),
});
export type DownloadTicket = z.infer<typeof downloadTicketSchema>;

export interface StoredArtifact {
  key: string;
  sizeBytes: number;
  sha256: string;
  etag?: string;
}

export interface PlannedPart {
  partNumber: number;
  offset: number;
  sizeBytes: number;
}

/** Splits `sizeBytes` into parts of `partSizeBytes`, growing the part size if it would exceed 10,000 parts. */
export function planParts(
  sizeBytes: number,
  partSizeBytes: number = DEFAULT_PART_BYTES,
): PlannedPart[] {
  byteCountSchema.parse(sizeBytes);
  let partSize = Math.max(partSizeBytes, MIN_PART_BYTES);
  if (Math.ceil(sizeBytes / partSize) > MAX_PARTS) {
    partSize = Math.ceil(sizeBytes / MAX_PARTS / MIB) * MIB;
  }
  const parts: PlannedPart[] = [];
  for (let offset = 0, n = 1; offset < sizeBytes; offset += partSize, n++) {
    parts.push({ partNumber: n, offset, sizeBytes: Math.min(partSize, sizeBytes - offset) });
  }
  if (parts.length === 0) parts.push({ partNumber: 1, offset: 0, sizeBytes: 0 });
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Orchestrator side: holds credentials, hands out presigned URLs.

export interface ArtifactStoreOptions {
  /** Inject a client (tests). Defaults to one built from the config. */
  client?: S3Client;
  /** Clock for `expiresAt` (tests). */
  now?: () => Date;
}

export class ArtifactStore {
  readonly config: S3Config;
  readonly client: S3Client;
  private readonly now: () => Date;

  constructor(config: S3ConfigInput, options: ArtifactStoreOptions = {}) {
    this.config = s3ConfigSchema.parse(config);
    this.client =
      options.client ??
      new S3Client({
        endpoint: this.config.endpoint,
        region: this.config.region,
        forcePathStyle: this.config.forcePathStyle,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
        // Default flexible checksums add headers a presigned URL cannot carry; keep them opt-in.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
    this.now = options.now ?? (() => new Date());
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options?: ArtifactStoreOptions,
  ): ArtifactStore {
    return new ArtifactStore(s3ConfigFromEnv(env), options);
  }

  get bucket(): string {
    return this.config.bucket;
  }

  /** Enforces the size cap and returns presigned PUT URL(s) for one trial artifact. */
  async createUpload(input: CreateUploadRequest): Promise<UploadPlan> {
    const req = createUploadRequestSchema.parse(input);
    if (req.sizeBytes > req.maxBytes) {
      throw new ArtifactTransferError(
        "too_large",
        `${req.name} is ${req.sizeBytes} bytes, over the ${req.maxBytes} byte transfer cap`,
      );
    }
    const key = trialArtifactKey(req.runId, req.trialId, req.name);
    const expiresAt = new Date(this.now().getTime() + req.expiresInSec * 1000).toISOString();
    const base = {
      key,
      sizeBytes: req.sizeBytes,
      sha256: req.sha256,
      maxBytes: req.maxBytes,
      expiresAt,
    };

    if (req.sizeBytes <= MULTIPART_THRESHOLD_BYTES) {
      const put = await this.presignSinglePut(key, req.sizeBytes, req.sha256, req.expiresInSec);
      return uploadPlanSchema.parse({ kind: "single", ...base, method: "PUT", ...put });
    }

    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        Metadata: { [SHA256_METADATA_KEY]: req.sha256 },
      }),
    );
    const uploadId = created.UploadId;
    if (!uploadId) throw new ArtifactTransferError("http_error", `no UploadId for ${key}`);

    try {
      const planned = planParts(req.sizeBytes, req.partSizeBytes ?? DEFAULT_PART_BYTES);
      const parts = await Promise.all(
        planned.map(async (p) => ({
          ...p,
          url: await getSignedUrl(
            this.client,
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: p.partNumber,
              ContentLength: p.sizeBytes,
            }),
            { expiresIn: req.expiresInSec, signableHeaders: new Set(["content-length"]) },
          ),
          headers: { "content-length": String(p.sizeBytes) },
        })),
      );
      return uploadPlanSchema.parse({
        kind: "multipart",
        ...base,
        uploadId,
        partSizeBytes: planned[0]?.sizeBytes ?? DEFAULT_PART_BYTES,
        parts,
      });
    } catch (err) {
      await this.abortUpload({ kind: "multipart", key, uploadId }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Finishes an upload after the computer ran the plan. For multipart, the stored parts are listed and
   * checked against the plan (count, sizes, total) before S3 assembles them. Returns the stored object,
   * whose size must equal the plan's and whose recorded sha256 must equal the plan's.
   */
  async completeUpload(planInput: UploadPlan): Promise<StoredArtifact> {
    const plan = uploadPlanSchema.parse(planInput);
    if (plan.kind === "multipart") {
      const stored = await this.listAllParts(plan.key, plan.uploadId);
      const byNumber = new Map(stored.map((p) => [p.PartNumber, p]));
      const completed: { PartNumber: number; ETag: string }[] = [];
      let total = 0;
      for (const want of plan.parts) {
        const got = byNumber.get(want.partNumber);
        if (!got?.ETag) {
          throw new ArtifactTransferError(
            "size_mismatch",
            `${plan.key}: part ${want.partNumber} was not uploaded`,
          );
        }
        if (got.Size !== want.sizeBytes) {
          throw new ArtifactTransferError(
            "size_mismatch",
            `${plan.key}: part ${want.partNumber} is ${got.Size} bytes, expected ${want.sizeBytes}`,
          );
        }
        total += got.Size;
        completed.push({ PartNumber: want.partNumber, ETag: got.ETag });
      }
      if (
        stored.length !== plan.parts.length ||
        total !== plan.sizeBytes ||
        total > plan.maxBytes
      ) {
        throw new ArtifactTransferError(
          "size_mismatch",
          `${plan.key}: ${stored.length} parts / ${total} bytes stored, expected ${plan.parts.length} / ${plan.sizeBytes}`,
        );
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: plan.key,
          UploadId: plan.uploadId,
          MultipartUpload: { Parts: completed },
        }),
      );
    }

    const head = await this.head(plan.key);
    if (!head) throw new ArtifactTransferError("not_found", `${plan.key} was not uploaded`);
    if (head.sizeBytes !== plan.sizeBytes) {
      throw new ArtifactTransferError(
        "size_mismatch",
        `${plan.key} is ${head.sizeBytes} bytes, expected ${plan.sizeBytes}`,
      );
    }
    if (head.sha256 !== plan.sha256) {
      throw new ArtifactTransferError(
        "checksum_mismatch",
        `${plan.key}: recorded sha256 differs from the plan`,
      );
    }
    return head;
  }

  /** Abandons a multipart upload (frees the stored parts). No-op for single PUT plans. */
  async abortUpload(plan: Pick<UploadPlan, "kind" | "key"> & { uploadId?: string }): Promise<void> {
    if (plan.kind !== "multipart" || !plan.uploadId) return;
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: plan.key,
        UploadId: plan.uploadId,
      }),
    );
  }

  /** A presigned GET for one trial artifact, with the size and sha256 recorded at upload. */
  async createDownload(input: CreateDownloadRequest): Promise<DownloadTicket> {
    const req = createDownloadRequestSchema.parse(input);
    const key = trialArtifactKey(req.runId, req.trialId, req.name);
    const head = await this.head(key);
    if (!head) throw new ArtifactTransferError("not_found", `${key} does not exist`);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: req.expiresInSec,
      },
    );
    return downloadTicketSchema.parse({
      key,
      url,
      sizeBytes: head.sizeBytes,
      sha256: head.sha256,
      expiresAt: new Date(this.now().getTime() + req.expiresInSec * 1000).toISOString(),
    });
  }

  /** The stored object, or null when it does not exist. Throws if it exists without a recorded sha256. */
  async head(key: string): Promise<StoredArtifact | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      const sha256 = res.Metadata?.[SHA256_METADATA_KEY];
      if (!sha256 || !sha256Schema.safeParse(sha256).success) {
        throw new ArtifactTransferError("checksum_mismatch", `${key} has no recorded sha256`);
      }
      return {
        key,
        sizeBytes: res.ContentLength ?? 0,
        sha256,
        ...(res.ETag ? { etag: res.ETag } : {}),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Write a small server-owned artifact (serverArtifactKey); the server's own bytes, never a runner's. */
  async putServerArtifact(
    runId: string,
    name: string,
    body: Uint8Array,
    contentType = "application/json",
  ): Promise<StoredArtifact> {
    const key = serverArtifactKey(runId, name);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
        Metadata: { [SHA256_METADATA_KEY]: sha256 },
      }),
    );
    return { key, sizeBytes: body.byteLength, sha256, ...(res.ETag ? { etag: res.ETag } : {}) };
  }

  /** Read a server-owned artifact, or null when it does not exist. Refuses one over `maxBytes`. */
  async getServerArtifact(
    runId: string,
    name: string,
    maxBytes = 16 * MIB,
  ): Promise<Uint8Array | null> {
    const key = serverArtifactKey(runId, name);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if ((res.ContentLength ?? 0) > maxBytes) {
        await res.Body?.transformToWebStream().cancel();
        throw new ArtifactTransferError("too_large", `${key} is over ${maxBytes} bytes`);
      }
      return res.Body ? await res.Body.transformToByteArray() : new Uint8Array(0);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Artifacts under `runs/<run>/trials/<trial>/` (names relative to that prefix). */
  async listTrialArtifacts(
    runId: string,
    trialId: string,
  ): Promise<{ name: string; key: string; sizeBytes: number }[]> {
    const prefix = trialPrefix(runId, trialId);
    const out: { name: string; key: string; sizeBytes: number }[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key)
          out.push({ name: obj.Key.slice(prefix.length), key: obj.Key, sizeBytes: obj.Size ?? 0 });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /**
   * One presigned PUT signed for exactly `sizeBytes` (content-length) and `sha256` (the recorded
   * metadata and the store-verified checksum), so it cannot store any other bytes.
   */
  private async presignSinglePut(
    key: string,
    sizeBytes: number,
    sha256: string,
    expiresInSec: number,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentLength: sizeBytes,
        Metadata: { [SHA256_METADATA_KEY]: sha256 },
        ChecksumSHA256: hexToBase64(sha256),
      }),
      {
        expiresIn: expiresInSec,
        signableHeaders: new Set(["content-length", CHECKSUM_SHA256_HEADER]),
        unhoistableHeaders: new Set([SHA256_HEADER, CHECKSUM_SHA256_HEADER]),
      },
    );
    return {
      url,
      headers: {
        "content-length": String(sizeBytes),
        [SHA256_HEADER]: sha256,
        [CHECKSUM_SHA256_HEADER]: hexToBase64(sha256),
      },
    };
  }

  // ----- kit uploads (TDM-217 [19.1]) -----

  /** A presigned PUT for a user's kit tarball at kitUploadKey (single PUT; caps at `maxBytes`). */
  async createKitUpload(input: {
    ownerId: string;
    uploadId: string;
    sizeBytes: number;
    sha256: string;
    maxBytes: number;
    expiresInSec: number;
  }): Promise<{ key: string; url: string; headers: Record<string, string>; expiresAt: string }> {
    sha256Schema.parse(input.sha256);
    byteCountSchema.parse(input.sizeBytes);
    if (input.sizeBytes > input.maxBytes || input.sizeBytes > MULTIPART_THRESHOLD_BYTES) {
      throw new ArtifactTransferError(
        "too_large",
        `kit tarball is ${input.sizeBytes} bytes, over the ${input.maxBytes} byte cap`,
      );
    }
    const expiresInSec = Math.min(Math.max(1, input.expiresInSec), MAX_PRESIGN_SECONDS);
    const key = kitUploadKey(input.ownerId, input.uploadId);
    const put = await this.presignSinglePut(key, input.sizeBytes, input.sha256, expiresInSec);
    const expiresAt = new Date(this.now().getTime() + expiresInSec * 1000).toISOString();
    return { key, ...put, expiresAt };
  }

  /**
   * The uploaded kit tarball's bytes, or null when nothing was uploaded under that id for that
   * owner. Refuses one over `maxBytes` without reading it, and one whose bytes do not hash to the
   * sha256 recorded at upload.
   */
  async getKitUpload(
    ownerId: string,
    uploadId: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; sha256: string } | null> {
    const key = kitUploadKey(ownerId, uploadId);
    const head = await this.head(key);
    if (!head) return null;
    if (head.sizeBytes > maxBytes) {
      throw new ArtifactTransferError("too_large", `${key} is over ${maxBytes} bytes`);
    }
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if ((res.ContentLength ?? 0) > maxBytes) {
      await res.Body?.transformToWebStream().cancel();
      throw new ArtifactTransferError("too_large", `${key} is over ${maxBytes} bytes`);
    }
    const bytes = res.Body ? await res.Body.transformToByteArray() : new Uint8Array(0);
    if (bytes.byteLength > maxBytes) {
      throw new ArtifactTransferError("too_large", `${key} is over ${maxBytes} bytes`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== head.sha256) {
      throw new ArtifactTransferError(
        "checksum_mismatch",
        `${key}: bytes differ from the recorded sha256`,
      );
    }
    return { bytes, sha256 };
  }

  /** Remove an uploaded kit tarball (after it was stored as a kit, or refused). */
  async deleteKitUpload(ownerId: string, uploadId: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: kitUploadKey(ownerId, uploadId) }),
    );
  }

  /** Store a validated kit's tarball at kitFilesKey (the server's own write). */
  async putKitFiles(ownerId: string, kitId: string, body: Uint8Array): Promise<StoredArtifact> {
    const key = kitFilesKey(ownerId, kitId);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/gzip",
        ContentLength: body.byteLength,
        Metadata: { [SHA256_METADATA_KEY]: sha256 },
      }),
    );
    return { key, sizeBytes: body.byteLength, sha256, ...(res.ETag ? { etag: res.ETag } : {}) };
  }

  /**
   * TDM-218: a stored kit tarball's bytes (a kitFilesKey only), or null when it does not exist.
   * Refuses one over `maxBytes` and one whose bytes do not hash to the recorded sha256.
   */
  async getKitFiles(key: string, maxBytes: number): Promise<Uint8Array | null> {
    if (!KIT_FILES_KEY_RE.test(key)) {
      throw new ArtifactTransferError("not_found", `${key} is not a stored kit`);
    }
    const head = await this.head(key);
    if (!head) return null;
    if (head.sizeBytes > maxBytes) {
      throw new ArtifactTransferError("too_large", `${key} is over ${maxBytes} bytes`);
    }
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if ((res.ContentLength ?? 0) > maxBytes) {
      await res.Body?.transformToWebStream().cancel();
      throw new ArtifactTransferError("too_large", `${key} is over ${maxBytes} bytes`);
    }
    const bytes = res.Body ? await res.Body.transformToByteArray() : new Uint8Array(0);
    if (bytes.byteLength > maxBytes) {
      throw new ArtifactTransferError("too_large", `${key} is over ${maxBytes} bytes`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== head.sha256) {
      throw new ArtifactTransferError(
        "checksum_mismatch",
        `${key}: bytes differ from the recorded sha256`,
      );
    }
    return bytes;
  }

  /** A presigned GET for a stored kit tarball (a kitFilesKey only). */
  async createKitDownload(
    key: string,
    expiresInSec = DEFAULT_PRESIGN_SECONDS,
  ): Promise<DownloadTicket> {
    if (!KIT_FILES_KEY_RE.test(key)) {
      throw new ArtifactTransferError("not_found", `${key} is not a stored kit`);
    }
    const head = await this.head(key);
    if (!head) throw new ArtifactTransferError("not_found", `${key} does not exist`);
    const seconds = Math.min(Math.max(1, expiresInSec), MAX_PRESIGN_SECONDS);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: seconds },
    );
    return downloadTicketSchema.parse({
      key,
      url,
      sizeBytes: head.sizeBytes,
      sha256: head.sha256,
      expiresAt: new Date(this.now().getTime() + seconds * 1000).toISOString(),
    });
  }

  private async listAllParts(key: string, uploadId: string): Promise<Part[]> {
    const parts: Part[] = [];
    let marker: string | undefined;
    do {
      const res = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      parts.push(...(res.Parts ?? []));
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof S3ServiceException) {
    return (
      err.name === "NotFound" || err.name === "NoSuchKey" || err.$metadata.httpStatusCode === 404
    );
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Computer side: no credentials, only presigned URLs.

export type FetchLike = typeof fetch;

export interface TransferOptions {
  fetch?: FetchLike;
  /** Parallel part uploads (multipart only). Default 4. */
  concurrency?: number;
}

/** sha256 (hex) and size of a local file, streamed. */
export async function sha256File(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const fh = await open(path, "r");
  try {
    for await (const chunk of fh.createReadStream() as AsyncIterable<Buffer>) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
  } finally {
    await fh.close().catch(() => undefined);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function putBytes(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<string | null> {
  // fetch sets content-length from the body; passing it twice is rejected by some runtimes.
  const sendHeaders = Object.fromEntries(
    Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-length"),
  );
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: sendHeaders,
    body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ArtifactTransferError(
      "http_error",
      `PUT failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }
  await res.arrayBuffer().catch(() => undefined);
  return res.headers.get("etag");
}

/**
 * Uploads a local file by running an `UploadPlan`. The bytes are hashed as they are read, and the upload
 * is refused if the file's size or sha256 differ from the plan. For multipart, the orchestrator still has
 * to call `ArtifactStore.completeUpload` afterwards.
 */
export async function uploadFileWithPlan(
  planInput: UploadPlan,
  filePath: string,
  options: TransferOptions = {},
): Promise<{ parts: { partNumber: number; etag: string | null }[] }> {
  const plan = uploadPlanSchema.parse(planInput);
  const fetchImpl = options.fetch ?? fetch;
  const { size } = await stat(filePath);
  if (size !== plan.sizeBytes) {
    throw new ArtifactTransferError(
      "size_mismatch",
      `${filePath} is ${size} bytes, plan says ${plan.sizeBytes}`,
    );
  }
  if (size > plan.maxBytes) {
    throw new ArtifactTransferError(
      "too_large",
      `${filePath} is ${size} bytes, over the ${plan.maxBytes} byte cap`,
    );
  }

  const fh = await open(filePath, "r");
  try {
    const readExact = async (offset: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await fh.read(buf, done, length - done, offset + done);
        if (bytesRead === 0)
          throw new ArtifactTransferError("size_mismatch", `${filePath} shrank while uploading`);
        done += bytesRead;
      }
      return buf;
    };
    const hash = createHash("sha256");

    if (plan.kind === "single") {
      const body = await readExact(0, plan.sizeBytes);
      hash.update(body);
      if (hash.digest("hex") !== plan.sha256) {
        throw new ArtifactTransferError(
          "checksum_mismatch",
          `${filePath}: sha256 differs from the plan`,
        );
      }
      const etag = await putBytes(fetchImpl, plan.url, plan.headers, body);
      return { parts: [{ partNumber: 1, etag }] };
    }

    // Read parts in order (so the hash is sequential), upload up to `concurrency` at once.
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const results: { partNumber: number; etag: string | null }[] = [];
    const inFlight = new Set<Promise<void>>();
    let failure: unknown;
    for (const part of plan.parts) {
      if (failure) break;
      const body = await readExact(part.offset, part.sizeBytes);
      hash.update(body);
      const task: Promise<void> = putBytes(fetchImpl, part.url, part.headers, body)
        .then((etag) => {
          results.push({ partNumber: part.partNumber, etag });
        })
        .catch((err: unknown) => {
          failure ??= err;
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
      if (inFlight.size >= concurrency) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    if (failure) throw failure;
    if (hash.digest("hex") !== plan.sha256) {
      throw new ArtifactTransferError(
        "checksum_mismatch",
        `${filePath}: sha256 differs from the plan`,
      );
    }
    return { parts: results.sort((a, b) => a.partNumber - b.partNumber) };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Fetches a presigned GET to `destPath`, hashing as it streams. On a size or sha256 mismatch the file is
 * deleted and the call throws, so a scoring computer never scores bytes that differ from what was uploaded.
 */
export async function downloadToFile(
  ticketInput: DownloadTicket,
  destPath: string,
  options: Pick<TransferOptions, "fetch"> & { maxBytes?: number } = {},
): Promise<{ sha256: string; sizeBytes: number }> {
  const ticket = downloadTicketSchema.parse(ticketInput);
  const fetchImpl = options.fetch ?? fetch;
  const limit = Math.min(ticket.sizeBytes, options.maxBytes ?? Number.MAX_SAFE_INTEGER);
  if (ticket.sizeBytes > limit) {
    throw new ArtifactTransferError(
      "too_large",
      `${ticket.key} is ${ticket.sizeBytes} bytes, over the ${limit} byte cap`,
    );
  }
  const res = await fetchImpl(ticket.url);
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ArtifactTransferError(
      "http_error",
      `GET ${ticket.key} failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }

  const hash = createHash("sha256");
  let sizeBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sizeBytes += chunk.length;
      if (sizeBytes > limit) {
        cb(
          new ArtifactTransferError(
            "size_mismatch",
            `${ticket.key}: more than ${limit} bytes received`,
          ),
        );
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      meter,
      createWriteStream(destPath),
    );
    const sha256 = hash.digest("hex");
    if (sizeBytes !== ticket.sizeBytes) {
      throw new ArtifactTransferError(
        "size_mismatch",
        `${ticket.key}: got ${sizeBytes} bytes, expected ${ticket.sizeBytes}`,
      );
    }
    if (sha256 !== ticket.sha256) {
      throw new ArtifactTransferError(
        "checksum_mismatch",
        `${ticket.key}: sha256 ${sha256} != recorded ${ticket.sha256}`,
      );
    }
    return { sha256, sizeBytes };
  } catch (err) {
    await rm(destPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
