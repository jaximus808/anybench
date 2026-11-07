// Ingest a binary (URL, upload or local file) with its docs into a ProjectDigest (plan.md P2).
//
// The subject is untrusted: it is NEVER executed on the host. `--help`, `-h` and `--version` are
// captured in a throwaway container (`docker run --rm --network none`, read-only, no caps, 10 s
// timeout, random name). Release archives (.tar.gz / .tar.xz / .tar) are unpacked with the host
// `tar` (unpacking runs no subject code); only regular files are read back, symlinks are ignored.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createRedactor,
  KitSha256Schema,
  ProjectDigestSchema,
  type ProjectDigest,
  type ProjectDigestInput,
} from "@anybench/core";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// File type from magic bytes.

export const BinaryFileTypeSchema = z.enum([
  "elf",
  "macho",
  "pe",
  "script",
  "tar",
  "gzip",
  "xz",
  "zip",
  "unknown",
]);
export type BinaryFileType = z.infer<typeof BinaryFileTypeSchema>;

export const BinaryArchSchema = z.enum(["x86_64", "aarch64", "arm", "x86", "riscv64", "other"]);
export type BinaryArch = z.infer<typeof BinaryArchSchema>;

export interface BinaryFileInfo {
  type: BinaryFileType;
  /** ELF only: the CPU the binary was built for. */
  arch?: BinaryArch;
  /** ELF only: 32 or 64 bit. */
  bits?: 32 | 64;
  /** Scripts only: the shebang line without `#!`, e.g. `/bin/sh` or `/usr/bin/env python3`. */
  interpreter?: string;
}

const ELF_MACHINES: Readonly<Record<number, BinaryArch>> = {
  0x03: "x86",
  0x28: "arm",
  0x3e: "x86_64",
  0xb7: "aarch64",
  0xf3: "riscv64",
};

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);

/** Classify a file from its first bytes (512 is enough for every type here, tar needs 262). */
export function detectFileType(head: Uint8Array): BinaryFileInfo {
  const b = head;
  const at = (i: number): number => b[i] ?? -1;
  if (at(0) === 0x7f && at(1) === 0x45 && at(2) === 0x4c && at(3) === 0x46) {
    const bits = at(4) === 2 ? 64 : 32;
    const le = at(5) !== 2;
    const machine = le ? at(18) | (at(19) << 8) : (at(18) << 8) | at(19);
    return { type: "elf", bits, arch: ELF_MACHINES[machine] ?? "other" };
  }
  if (b.length >= 4) {
    const magic = ((at(0) << 24) | (at(1) << 16) | (at(2) << 8) | at(3)) >>> 0;
    if (MACHO_MAGICS.has(magic)) return { type: "macho" };
  }
  if (at(0) === 0x23 && at(1) === 0x21) {
    const text = Buffer.from(b.subarray(2, Math.min(b.length, 256))).toString("utf8");
    const line = (text.split("\n")[0] ?? "").trim();
    return line.length > 0 ? { type: "script", interpreter: line } : { type: "script" };
  }
  if (at(0) === 0x4d && at(1) === 0x5a) return { type: "pe" };
  if (at(0) === 0x1f && at(1) === 0x8b) return { type: "gzip" };
  if (at(0) === 0xfd && at(1) === 0x37 && at(2) === 0x7a && at(3) === 0x58 && at(4) === 0x5a) {
    return { type: "xz" };
  }
  if (at(0) === 0x50 && at(1) === 0x4b && at(2) === 0x03 && at(3) === 0x04) return { type: "zip" };
  if (Buffer.from(b.subarray(257, 262)).toString("latin1") === "ustar") return { type: "tar" };
  return { type: "unknown" };
}

async function readHead(path: string, n = 512): Promise<Uint8Array> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function sha256Of(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const fh = await open(path, "r");
  try {
    for await (const chunk of fh.createReadStream() as AsyncIterable<Buffer>) {
      hash.update(chunk);
      size += chunk.length;
    }
  } finally {
    await fh.close().catch(() => undefined);
  }
  return { sha256: hash.digest("hex"), size };
}

// ---------------------------------------------------------------------------------------------
// Sandbox: run the subject in a throwaway container, never on the host.

export interface SandboxRunRequest {
  /** Host path of the subject, mounted read-only at /bin/subject. */
  binaryPath: string;
  args: readonly string[];
  /** Docker platform, e.g. `linux/amd64`; omitted for scripts (host-native image). */
  platform?: string;
  timeoutMs: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when stdout or stderr hit the output cap. */
  truncated?: boolean;
  /** Set when the sandbox itself failed (docker missing, image not present, ...). */
  error?: string;
}

export type SandboxRunner = (req: SandboxRunRequest) => Promise<SandboxRunResult>;

export interface DockerSandboxOptions {
  /** Default `debian:stable-slim`. */
  image?: string;
  /** Docker CLI binary. Default `docker`. */
  docker?: string;
  /** `--pull` policy. Default `missing`; tests use `never` so they never touch the network. */
  pull?: "missing" | "never" | "always";
  /** Per-stream output cap in bytes. Default 64 KiB. */
  maxOutputBytes?: number;
  /** Timeout for `docker create` (which may pull the image). Default 5 min. */
  setupTimeoutMs?: number;
  /** Container name prefix; a random suffix is added. Default `anybench-ingest-`. */
  namePrefix?: string;
}

export const SANDBOX_MOUNT_PATH = "/bin/subject";
export const DEFAULT_SANDBOX_IMAGE = "debian:stable-slim";

/**
 * The exact `docker create` argv for one sandboxed run (pure; exported for tests and audit).
 * The container is created first and then started with `docker start -a`, so the 10 s timeout
 * covers only the subject (not image setup on a loaded host) and a timed-out container always
 * exists by name when it is force-removed.
 */
export function dockerSandboxArgs(
  req: SandboxRunRequest,
  containerName: string,
  opts: Pick<DockerSandboxOptions, "image" | "pull"> = {},
): string[] {
  const args = ["create", "--rm", "--name", containerName, "--network", "none"];
  args.push("--pull", opts.pull ?? "missing");
  if (req.platform) args.push("--platform", req.platform);
  args.push(
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "256m",
    "--pids-limit",
    "128",
    "--user",
    "65534:65534",
    "-e",
    "HOME=/tmp",
    "-e",
    "TERM=dumb",
    "-e",
    "COLUMNS=100",
    "-v",
    `${req.binaryPath}:${SANDBOX_MOUNT_PATH}:ro`,
    opts.image ?? DEFAULT_SANDBOX_IMAGE,
    SANDBOX_MOUNT_PATH,
    ...req.args,
  );
  return args;
}

/**
 * A SandboxRunner backed by Docker: `docker create --rm --network none ...` then
 * `docker start -a` under the timeout, `docker rm -f` on timeout. Container names are random
 * (`<namePrefix><12 hex>`), so parallel runs never collide.
 */
export function createDockerSandbox(opts: DockerSandboxOptions = {}): SandboxRunner {
  const docker = opts.docker ?? "docker";
  const cap = opts.maxOutputBytes ?? 64 * 1024;
  const setupTimeoutMs = opts.setupTimeoutMs ?? 300_000;
  const prefix = opts.namePrefix ?? "anybench-ingest-";
  return async (req) => {
    const name = `${prefix}${randomBytes(6).toString("hex")}`;
    // Create (may pull the image): generous timeout, not charged to the subject.
    const created = await runOnce(docker, dockerSandboxArgs(req, name, opts), setupTimeoutMs, cap);
    if (created.exitCode !== 0) {
      await removeContainer(docker, name);
      const why = created.timedOut ? "timed out" : (created.error ?? created.stderr).trim();
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: `docker create failed: ${why.slice(0, 500)}`,
      };
    }
    const r = await runOnce(docker, ["start", "-a", name], req.timeoutMs, cap);
    // `--rm` removes it on exit; on timeout (or a failed start) remove it ourselves.
    if (r.timedOut || r.exitCode === null || r.exitCode === 125)
      await removeContainer(docker, name);
    if (r.exitCode === 125 && r.error === undefined) {
      r.error = `docker start failed: ${r.stderr.trim().slice(0, 500)}`;
    }
    return r;
  };
}

function removeContainer(docker: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(docker, ["rm", "-f", name], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function runOnce(
  docker: string,
  args: string[],
  timeoutMs: number,
  cap: number,
): Promise<SandboxRunResult> {
  return new Promise<SandboxRunResult>((resolve) => {
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    child.stdout.on("data", (c: Buffer) => {
      if (outLen < cap) out.push(c);
      outLen += c.length;
    });
    child.stderr.on("data", (c: Buffer) => {
      if (errLen < cap) err.push(c);
      errLen += c.length;
    });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const res: SandboxRunResult = {
        exitCode,
        stdout: Buffer.concat(out).subarray(0, cap).toString("utf8"),
        stderr: Buffer.concat(err).subarray(0, cap).toString("utf8"),
        timedOut,
      };
      if (outLen > cap || errLen > cap) res.truncated = true;
      if (error !== undefined) res.error = error;
      resolve(res);
    };
    child.on("error", (e) => finish(null, `sandbox failed to start: ${e.message}`));
    child.on("close", (code) => finish(timedOut ? null : code));
  });
}

/** Docker platform for a binary, or undefined plus a reason when it cannot run in a Linux box. */
export function sandboxPlatformFor(info: BinaryFileInfo): { platform?: string; skip?: string } {
  switch (info.type) {
    case "script":
      return {};
    case "elf":
      switch (info.arch) {
        case "x86_64":
          return { platform: "linux/amd64" };
        case "aarch64":
          return { platform: "linux/arm64" };
        case "arm":
          return { platform: "linux/arm/v7" };
        case "x86":
          return { platform: "linux/386" };
        case "riscv64":
          return { platform: "linux/riscv64" };
        default:
          return { skip: "ELF binary for an unsupported CPU; not run" };
      }
    case "macho":
      return { skip: "Mach-O binary: there is no macOS sandbox, so it is not run" };
    case "pe":
      return { skip: "Windows PE binary: there is no Windows sandbox, so it is not run" };
    default:
      return { skip: `file type ${info.type} is not executable; not run` };
  }
}

// ---------------------------------------------------------------------------------------------
// Docs.

export const BinaryDocKindSchema = z.enum(["readme", "man", "api", "other"]);
export type BinaryDocKind = z.infer<typeof BinaryDocKindSchema>;

/** Best-effort roff (man page source) to plain text. */
export function roffToText(src: string): string {
  const lines: string[] = [];
  for (const raw of src.split("\n")) {
    if (/^\.\s*\\"/.test(raw) || raw.startsWith("'\\\"") || /^\.\\"/.test(raw)) continue;
    const m = /^\.([A-Za-z]{1,3})\s*(.*)$/.exec(raw);
    let line = raw;
    if (m) {
      const macro = m[1] ?? "";
      const rest = (m[2] ?? "").replace(/^"(.*)"$/, "$1");
      if (macro === "SH" || macro === "SS") {
        lines.push("", rest.toUpperCase());
        continue;
      }
      if (["PP", "LP", "P", "sp", "br", "TP", "IP", "RS", "RE", "nf", "fi"].includes(macro)) {
        if (macro === "PP" || macro === "LP" || macro === "P" || macro === "sp") lines.push("");
        if (macro !== "IP" || rest.length === 0) continue;
      }
      line = rest;
    }
    line = line
      .replace(/\\f(?:\[[^\]]*\]|\(..|.)/g, "")
      .replace(/\\\(em/g, "--")
      .replace(/\\\(en/g, "-")
      .replace(/\\\(bu/g, "*")
      .replace(/\\\((?:lq|rq|dq)/g, '"')
      .replace(/\\-/g, "-")
      .replace(/\\&/g, "")
      .replace(/\\e/g, "\\")
      .replace(/\\ /g, " ");
    lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function guessDocKind(name: string): BinaryDocKind {
  const base = basename(name).toLowerCase();
  if (/^readme(\.|$)/.test(base)) return "readme";
  if (/\.[1-8][a-z]*$/.test(base) || /\.man$/.test(base)) return "man";
  if (/(^|[-_.])(api|openapi|swagger)([-_.]|$)/.test(base)) return "api";
  return "other";
}

// ---------------------------------------------------------------------------------------------
// Input, result and errors.

const DocInputSchema = z.union([
  z.strictObject({
    name: z.string().min(1),
    text: z.string(),
    kind: BinaryDocKindSchema.optional(),
  }),
  z.strictObject({
    path: z.string().min(1),
    name: z.string().min(1).optional(),
    kind: BinaryDocKindSchema.optional(),
  }),
]);

export const BinaryIngestInputSchema = z
  .strictObject({
    /** http(s) URL of the binary or its release archive. */
    url: z.url({ protocol: /^https?$/ }).optional(),
    /** Local path of the binary or archive (e.g. an upload already downloaded). */
    path: z.string().min(1).optional(),
    upload_id: z.string().min(1).optional(),
    /** If set, the downloaded/read file must hash to this. */
    expected_sha256: KitSha256Schema.optional(),
    /** Subject name; default the binary's file name. */
    name: z.string().min(1).optional(),
    /** Archive member to ingest (path inside the archive); default: the one executable in it. */
    member: z.string().min(1).optional(),
    /** Docs provided alongside: inline text or local paths. */
    docs: z.array(DocInputSchema).default([]),
  })
  .refine((v) => (v.url === undefined) !== (v.path === undefined), {
    error: "give exactly one of url or path",
  });
export type BinaryIngestInput = z.input<typeof BinaryIngestInputSchema>;

export const BinaryCaptureSchema = z.strictObject({
  args: z.array(z.string()),
  exit_code: z.int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timed_out: z.boolean(),
  /** stdout or stderr hit the sandbox output cap. */
  truncated: z.boolean().default(false),
  /** Why the capture did not run (or the sandbox error), if it did not. */
  skipped: z.string().optional(),
});
export type BinaryCapture = z.infer<typeof BinaryCaptureSchema>;

export const BinaryDocSchema = z.strictObject({
  name: z.string().min(1),
  kind: BinaryDocKindSchema,
  /** Plain text (man pages are converted from roff), redacted, capped. */
  text: z.string(),
  bytes: z.int().min(0),
  truncated: z.boolean(),
});
export type BinaryDoc = z.infer<typeof BinaryDocSchema>;

export const BinaryIngestResultSchema = z.strictObject({
  digest: ProjectDigestSchema,
  binary: z.strictObject({
    name: z.string().min(1),
    type: BinaryFileTypeSchema,
    arch: BinaryArchSchema.optional(),
    bits: z.union([z.literal(32), z.literal(64)]).optional(),
    interpreter: z.string().optional(),
    sha256: KitSha256Schema,
    size_bytes: z.int().min(0),
    /** Set when the binary came out of an archive. */
    archive: z
      .strictObject({
        type: BinaryFileTypeSchema,
        sha256: KitSha256Schema,
        size_bytes: z.int().min(0),
        member: z.string().min(1),
      })
      .optional(),
  }),
  captures: z.array(BinaryCaptureSchema),
  docs: z.array(BinaryDocSchema),
});
export type BinaryIngestResult = z.infer<typeof BinaryIngestResultSchema>;

export type BinaryIngestErrorCode =
  | "invalid_input"
  | "download_failed"
  | "too_large"
  | "sha256_mismatch"
  | "not_found"
  | "unsupported_archive"
  | "no_binary_in_archive";

export class BinaryIngestError extends Error {
  readonly code: BinaryIngestErrorCode;
  constructor(code: BinaryIngestErrorCode, message: string) {
    super(message);
    this.name = "BinaryIngestError";
    this.code = code;
  }
}

export interface BinaryIngestOptions {
  /** Where the subject runs. Default: createDockerSandbox(). */
  sandbox?: SandboxRunner;
  /** fetch implementation for `url`. Default: global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Download cap. Default 512 MiB. */
  maxDownloadBytes?: number;
  /** Per-doc text cap. Default 64 KiB. */
  maxDocBytes?: number;
  /** Per-capture timeout. Default 10 s. */
  timeoutMs?: number;
  /** Flags to capture, in order. Default `--help`, `-h`, `--version`. */
  captureArgs?: readonly (readonly string[])[];
}

export const DEFAULT_CAPTURE_ARGS: readonly (readonly string[])[] = [
  ["--help"],
  ["-h"],
  ["--version"],
];

// ---------------------------------------------------------------------------------------------
// Download and archives.

async function download(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow" });
  } catch (e) {
    throw new BinaryIngestError("download_failed", `GET ${url}: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) {
    throw new BinaryIngestError("download_failed", `GET ${url}: HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BinaryIngestError("too_large", `GET ${url}: ${declared} bytes > cap ${maxBytes}`);
  }
  let seen = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (c: Buffer) => {
    seen += c.length;
    if (seen > maxBytes) {
      body.destroy(new BinaryIngestError("too_large", `GET ${url}: more than ${maxBytes} bytes`));
    }
  });
  await pipeline(body, createWriteStream(dest, { mode: 0o600 }));
}

function runTar(archive: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `-xf` auto-detects gzip/xz in both GNU tar and bsdtar; both refuse `..` and absolute
    // member paths by default. Extraction runs no subject code.
    const child = spawn("tar", ["-xf", archive, "-C", outDir, "--no-same-owner"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (e) =>
      reject(new BinaryIngestError("unsupported_archive", `tar: ${e.message}`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new BinaryIngestError("unsupported_archive", `tar exit ${code}: ${stderr}`)),
    );
  });
}

interface WalkedFile {
  abs: string;
  rel: string;
  mode: number;
  size: number;
}

/** Regular files under `root`, symlinks ignored (an archive cannot point us outside it). */
async function walkRegular(root: string, limit = 10_000): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop() as string;
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) {
        const st = await lstat(abs);
        out.push({
          abs,
          rel: relative(root, abs).split(sep).join("/"),
          mode: st.mode,
          size: st.size,
        });
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function stripTopDir(rel: string): string {
  const parts = rel.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : rel;
}

// ---------------------------------------------------------------------------------------------
// Ingest.

const SEMVER_RE = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

function firstLine(s: string): string | undefined {
  return s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

/**
 * Ingest a binary with its docs. Returns the digest plus the evidence it was built from (help
 * captures and docs text), all redacted. Throws BinaryIngestError on bad input or downloads.
 */
export async function ingestBinary(
  rawInput: BinaryIngestInput,
  options: BinaryIngestOptions = {},
): Promise<BinaryIngestResult> {
  const parsed = BinaryIngestInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new BinaryIngestError(
      "invalid_input",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  const input = parsed.data;
  const sandbox = options.sandbox ?? createDockerSandbox();
  const now = options.now ?? (() => new Date());
  const maxDoc = options.maxDocBytes ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const redactor = createRedactor();
  const work = await mkdtemp(join(tmpdir(), "anybench-ingest-bin-"));
  try {
    // 1. Get the file (download or local).
    let fetched: string;
    if (input.url !== undefined) {
      fetched = join(work, "download");
      await download(
        input.url,
        fetched,
        options.fetch ?? fetch,
        options.maxDownloadBytes ?? 512 * 1024 * 1024,
      );
    } else {
      fetched = input.path as string;
      const st = await lstat(fetched).catch(() => undefined);
      if (!st?.isFile()) throw new BinaryIngestError("not_found", `no regular file at ${fetched}`);
    }
    const fetchedHash = await sha256Of(fetched);
    if (input.expected_sha256 !== undefined && input.expected_sha256 !== fetchedHash.sha256) {
      throw new BinaryIngestError(
        "sha256_mismatch",
        `sha256 ${fetchedHash.sha256} != expected ${input.expected_sha256}`,
      );
    }
    const fetchedInfo = detectFileType(await readHead(fetched));
    const sourceName =
      input.url !== undefined
        ? basename(new URL(input.url).pathname) || "binary"
        : basename(fetched);

    // 2. Unpack archives; pick the binary and any docs shipped inside.
    let subjectPath = fetched;
    let info = fetchedInfo;
    let archive: BinaryIngestResult["binary"]["archive"];
    const docs: BinaryDoc[] = [];
    const pushDoc = (name: string, kind: BinaryDocKind, rawText: string): void => {
      const text = redactor(kind === "man" ? roffToText(rawText) : rawText);
      const bytes = Buffer.byteLength(text);
      const truncated = bytes > maxDoc;
      docs.push({
        name,
        kind,
        text: truncated ? Buffer.from(text).subarray(0, maxDoc).toString("utf8") : text,
        bytes,
        truncated,
      });
    };
    if (["tar", "gzip", "xz"].includes(fetchedInfo.type)) {
      const outDir = await mkdtemp(join(work, "x-"));
      await runTar(fetched, outDir);
      const files = await walkRegular(outDir);
      const typed = await Promise.all(
        files.map(async (f) => ({ ...f, info: detectFileType(await readHead(f.abs)) })),
      );
      let pick: (typeof typed)[number] | undefined;
      if (input.member !== undefined) {
        const want = input.member.replace(/^\.?\//, "");
        pick = typed.find((f) => f.rel === want || stripTopDir(f.rel) === want);
        if (!pick) {
          throw new BinaryIngestError("no_binary_in_archive", `member ${input.member} not found`);
        }
      } else {
        const exe = typed.filter((f) => ["elf", "macho", "pe"].includes(f.info.type));
        const hint = input.name;
        pick =
          (hint !== undefined ? exe.find((f) => basename(f.rel) === hint) : undefined) ??
          exe.find((f) => (f.mode & 0o111) !== 0) ??
          exe[0];
        if (!pick) {
          throw new BinaryIngestError(
            "no_binary_in_archive",
            `no ELF/Mach-O/PE file in archive ${sourceName}`,
          );
        }
      }
      subjectPath = pick.abs;
      info = pick.info;
      archive = {
        type: fetchedInfo.type,
        sha256: fetchedHash.sha256,
        size_bytes: fetchedHash.size,
        member: pick.rel,
      };
      // Docs shipped in the archive: READMEs near the top and man pages.
      for (const f of typed) {
        if (f === pick || f.info.type !== "unknown" || f.size > 4 * 1024 * 1024) continue;
        const kind = guessDocKind(f.rel);
        const depth = stripTopDir(f.rel).split("/").length;
        if ((kind === "readme" && depth <= 2) || kind === "man") {
          pushDoc(stripTopDir(f.rel), kind, await readFile(f.abs, "utf8"));
        }
        if (docs.length >= 10) break;
      }
    } else if (fetchedInfo.type === "zip") {
      throw new BinaryIngestError("unsupported_archive", "zip archives are not supported yet");
    }
    const subjectHash = subjectPath === fetched ? fetchedHash : await sha256Of(subjectPath);
    const name = input.name ?? (archive !== undefined ? basename(subjectPath) : sourceName);

    // 3. Docs provided alongside.
    for (const d of input.docs) {
      if ("text" in d) pushDoc(d.name, d.kind ?? guessDocKind(d.name), d.text);
      else {
        const text = await readFile(d.path, "utf8").catch(() => {
          throw new BinaryIngestError("not_found", `doc not found: ${d.path}`);
        });
        const docName = d.name ?? basename(d.path);
        pushDoc(docName, d.kind ?? guessDocKind(docName), text);
      }
    }

    // 4. Capture --help / -h / --version in the sandbox.
    const { platform, skip } = sandboxPlatformFor(info);
    const captures: BinaryCapture[] = [];
    let staged: string | undefined;
    if (skip === undefined) {
      // Stage an executable copy so the read-only mount runs regardless of the source's mode.
      staged = join(await mkdtemp(join(work, "run-")), "subject");
      await copyFile(subjectPath, staged);
      await chmod(staged, 0o755);
    }
    for (const args of options.captureArgs ?? DEFAULT_CAPTURE_ARGS) {
      if (staged === undefined) {
        captures.push({
          args: [...args],
          exit_code: null,
          stdout: "",
          stderr: "",
          timed_out: false,
          truncated: false,
          skipped: skip ?? "not run",
        });
        continue;
      }
      const req: SandboxRunRequest = { binaryPath: staged, args, timeoutMs };
      if (platform !== undefined) req.platform = platform;
      const r = await sandbox(req);
      const cap: BinaryCapture = {
        args: [...args],
        exit_code: r.exitCode,
        stdout: redactor(r.stdout),
        stderr: redactor(r.stderr),
        timed_out: r.timedOut,
        truncated: r.truncated ?? false,
      };
      if (r.error !== undefined) cap.skipped = redactor(r.error);
      captures.push(cap);
    }

    // 5. Digest.
    const ok = (c: BinaryCapture): string | undefined =>
      c.skipped === undefined && !c.timed_out
        ? (firstLine(c.stdout) ?? firstLine(c.stderr))
        : undefined;
    const versionCap = captures.find((c) => c.args.includes("--version"));
    const versionLine = versionCap ? ok(versionCap) : undefined;
    // First help line that is not just the version banner again (`rg -h` starts with it).
    const helpLine = captures
      .filter((c) => c !== versionCap && c.skipped === undefined && !c.timed_out)
      .flatMap((c) => (c.stdout.trim() ? c.stdout : c.stderr).split("\n").map((l) => l.trim()))
      .find(
        (l) =>
          l.length > 0 &&
          l !== versionLine &&
          !l.includes("@") &&
          !/^usage\b/i.test(l) &&
          l.split(/\s+/).length >= 4,
      );
    const typeLabel =
      info.type === "elf"
        ? `ELF ${info.arch ?? ""} binary`.replace(/\s+/g, " ")
        : info.type === "script"
          ? `script (${info.interpreter ?? "no interpreter"})`
          : `${info.type} file`;
    const summaryParts = [`${name}: ${typeLabel}`];
    if (versionLine) summaryParts.push(versionLine);
    if (helpLine) summaryParts.push(helpLine);
    if (!versionLine && !helpLine) summaryParts.push(skip ?? "no help output captured");
    const version = versionLine ? SEMVER_RE.exec(versionLine)?.[1] : undefined;

    const source: Extract<ProjectDigestInput["source"], { kind: "binary" }> = {
      kind: "binary",
      sha256: fetchedHash.sha256,
      docs: docs.map((d) => d.name),
    };
    if (input.url !== undefined) source.url = input.url;
    if (input.upload_id !== undefined) source.upload_id = input.upload_id;
    const digestInput: ProjectDigestInput = {
      source,
      name,
      kind: "software",
      summary: redactor(summaryParts.join(" | ")),
      entrypoints: [{ kind: "bin", name, command: name, path: archive?.member ?? sourceName }],
      docs: docs.map((d) => d.name),
      releases: version ? { latest: version, tags: [] } : { tags: [] },
      files: {
        count: 1 + docs.length,
        total_bytes: subjectHash.size + docs.reduce((n, d) => n + d.bytes, 0),
      },
      suggested_driver_types: ["cli"],
      ingested_at: now().toISOString(),
      hash: subjectHash.sha256,
    };
    const digest: ProjectDigest = ProjectDigestSchema.parse(digestInput);

    const binary: BinaryIngestResult["binary"] = {
      name,
      type: info.type,
      sha256: subjectHash.sha256,
      size_bytes: subjectHash.size,
    };
    if (info.arch !== undefined) binary.arch = info.arch;
    if (info.bits !== undefined) binary.bits = info.bits;
    if (info.interpreter !== undefined) binary.interpreter = redactor(info.interpreter);
    if (archive !== undefined) binary.archive = archive;
    return BinaryIngestResultSchema.parse({ digest, binary, captures, docs });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
