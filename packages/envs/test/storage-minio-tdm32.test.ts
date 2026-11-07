// Integration test for TDM-32 (3.11): S3 artifact transfer against a throwaway MinIO container.
// Skips cleanly when Docker (or a MinIO image) is unavailable. The container is removed afterwards.
// Safe under parallel worktrees: every run gets its own container name (random suffix) and lets
// Docker pick a free host port (`-p 127.0.0.1::9000`, read back with `docker port`).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  MIB,
  downloadToFile,
  sha256File,
  uploadFileWithPlan,
  type UploadPlan,
} from "../src/storage.js";

const TDM32_CONTAINER = `ab-minio-tdm32-${process.pid}-${randomBytes(4).toString("hex")}`;
const TDM32_LABEL = "anybench.test=tdm32-minio";
const TDM32_IMAGES = ["minio/minio:latest", "pgsty/minio:latest"];
const TDM32_USER = "tdm32minio";
const TDM32_PASS = "tdm32minio-test-only";
const TDM32_BUCKET = "anybench-tdm32";

function docker(args: string[], timeoutMs = 30_000): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  }).trim();
}

function pickMinioImage(): string | null {
  try {
    docker(["info", "--format", "{{.ServerVersion}}"], 10_000);
  } catch {
    return null;
  }
  for (const image of TDM32_IMAGES) {
    try {
      docker(["image", "inspect", image, "--format", "{{.Id}}"]);
      return image;
    } catch {
      // not present locally
    }
  }
  for (const image of TDM32_IMAGES) {
    try {
      docker(["pull", image], 180_000);
      return image;
    } catch {
      // not pullable
    }
  }
  return null;
}

const tdm32Image = pickMinioImage();

describe.skipIf(!tdm32Image)("S3 artifact transfer against MinIO (TDM-32)", () => {
  let store: ArtifactStore;
  let dir: string;

  let containerStarted = false;

  function removeContainer(): void {
    if (!containerStarted) return;
    try {
      docker(["rm", "-f", "-v", TDM32_CONTAINER]);
      containerStarted = false;
    } catch {
      // already gone
    }
  }

  beforeAll(async () => {
    try {
      await startMinio();
    } catch (err) {
      // Don't leak the container if startup fails part-way (afterAll also removes it).
      removeContainer();
      throw err;
    }
  }, 240_000);

  async function startMinio(): Promise<void> {
    containerStarted = true; // set before `run`: a half-created container must still be removed
    docker([
      "run",
      "-d",
      "--name",
      TDM32_CONTAINER,
      "--label",
      TDM32_LABEL,
      "-p",
      "127.0.0.1::9000",
      "-e",
      `MINIO_ROOT_USER=${TDM32_USER}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${TDM32_PASS}`,
      tdm32Image!,
      "server",
      "/data",
    ]);
    const mapped = docker(["port", TDM32_CONTAINER, "9000/tcp"]).split("\n")[0] ?? "";
    const port = mapped.slice(mapped.lastIndexOf(":") + 1);
    if (!/^\d+$/.test(port)) throw new Error(`could not read MinIO host port from "${mapped}"`);
    const endpoint = `http://127.0.0.1:${port}`;

    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const res = await fetch(`${endpoint}/minio/health/ready`);
        if (res.ok) break;
      } catch {
        // starting
      }
      if (Date.now() > deadline) throw new Error("MinIO did not become ready");
      await new Promise((r) => setTimeout(r, 250));
    }

    store = new ArtifactStore({
      endpoint,
      region: "us-east-1",
      bucket: TDM32_BUCKET,
      accessKeyId: TDM32_USER,
      secretAccessKey: TDM32_PASS,
    });
    await store.client.send(new CreateBucketCommand({ Bucket: TDM32_BUCKET }));
    dir = await mkdtemp(join(tmpdir(), "anybench-tdm32-"));
  }

  afterAll(async () => {
    try {
      store?.client.destroy();
    } finally {
      removeContainer();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  async function writeRandomFile(name: string, sizeBytes: number): Promise<string> {
    const path = join(dir, name);
    const fh = await open(path, "w");
    try {
      for (let written = 0; written < sizeBytes;) {
        const chunk = randomBytes(Math.min(8 * MIB, sizeBytes - written));
        await fh.write(chunk);
        written += chunk.length;
      }
    } finally {
      await fh.close();
    }
    return path;
  }

  it("uploads and fetches a 200 MiB file via presigned URLs (multipart) with matching sha256", async () => {
    const size = 200 * MIB;
    const src = await writeRandomFile("big-200m.bin", size);
    const { sha256, sizeBytes } = await sha256File(src);
    expect(sizeBytes).toBe(size);

    const plan = await store.createUpload({
      runId: "run-tdm32",
      trialId: "trial-1",
      name: "out/scrollback.bin",
      sizeBytes,
      sha256,
      maxBytes: 256 * MIB,
    });
    expect(plan.kind).toBe("multipart");
    if (plan.kind !== "multipart") return;
    expect(plan.parts.length).toBe(13);

    // The computer side only sees URLs: a JSON round-trip proves the plan carries no client state.
    const wirePlan = JSON.parse(JSON.stringify(plan)) as UploadPlan;
    expect(JSON.stringify(wirePlan)).not.toContain(TDM32_PASS);
    const up = await uploadFileWithPlan(wirePlan, src);
    expect(up.parts).toHaveLength(13);

    const stored = await store.completeUpload(plan);
    expect(stored).toMatchObject({
      key: "runs/run-tdm32/trials/trial-1/out/scrollback.bin",
      sizeBytes: size,
      sha256,
    });

    const ticket = await store.createDownload({
      runId: "run-tdm32",
      trialId: "trial-1",
      name: "out/scrollback.bin",
    });
    expect(ticket.sha256).toBe(sha256);
    const dest = join(dir, "big-200m.fetched");
    const got = await downloadToFile(ticket, dest);
    expect(got).toEqual({ sha256, sizeBytes: size });
    expect((await sha256File(dest)).sha256).toBe(sha256);

    expect(await store.listTrialArtifacts("run-tdm32", "trial-1")).toEqual([
      {
        name: "out/scrollback.bin",
        key: "runs/run-tdm32/trials/trial-1/out/scrollback.bin",
        sizeBytes: size,
      },
    ]);
  }, 240_000);

  it("round-trips a small file with a single presigned PUT", async () => {
    const src = join(dir, "small.txt");
    await writeFile(src, "hello from trial 2\n");
    const { sha256, sizeBytes } = await sha256File(src);
    const plan = await store.createUpload({
      runId: "run-tdm32",
      trialId: "trial-2",
      name: "log.txt",
      sizeBytes,
      sha256,
      maxBytes: MIB,
    });
    expect(plan.kind).toBe("single");
    await uploadFileWithPlan(plan, src);
    await expect(store.completeUpload(plan)).resolves.toMatchObject({ sizeBytes, sha256 });
    const ticket = await store.createDownload({
      runId: "run-tdm32",
      trialId: "trial-2",
      name: "log.txt",
    });
    const dest = join(dir, "small.fetched");
    await expect(downloadToFile(ticket, dest)).resolves.toEqual({ sha256, sizeBytes });
  });

  it("rejects a PUT whose body length differs from the signed content-length", async () => {
    const plan = await store.createUpload({
      runId: "run-tdm32",
      trialId: "trial-3",
      name: "x.bin",
      sizeBytes: 10,
      sha256: "b".repeat(64),
      maxBytes: 10,
    });
    if (plan.kind !== "single") throw new Error("expected single");
    const res = await fetch(plan.url, {
      method: "PUT",
      headers: { "x-amz-meta-sha256": "b".repeat(64) },
      body: new Uint8Array(1000),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    await expect(store.head(plan.key)).resolves.toBeNull();
  });

  it("refuses to save a download whose bytes do not match the recorded sha256", async () => {
    const src = join(dir, "lie.txt");
    await writeFile(src, "real bytes\n");
    const { sizeBytes } = await sha256File(src);
    const lie = "c".repeat(64);
    const plan = await store.createUpload({
      runId: "run-tdm32",
      trialId: "trial-4",
      name: "lie.txt",
      sizeBytes,
      sha256: lie,
      maxBytes: MIB,
    });
    // The uploader hashes what it sends and refuses a plan whose sha256 is wrong...
    await expect(uploadFileWithPlan(plan, src)).rejects.toMatchObject({
      code: "checksum_mismatch",
    });
    // ...and if a dishonest uploader sends anyway, the scoring side refuses the bytes.
    if (plan.kind !== "single") throw new Error("expected single");
    const res = await fetch(plan.url, {
      method: "PUT",
      headers: { "x-amz-meta-sha256": lie },
      body: "real bytes\n",
    });
    expect(res.ok).toBe(true);
    const ticket = await store.createDownload({
      runId: "run-tdm32",
      trialId: "trial-4",
      name: "lie.txt",
    });
    const dest = join(dir, "lie.fetched");
    await expect(downloadToFile(ticket, dest)).rejects.toMatchObject({ code: "checksum_mismatch" });
    await expect(open(dest, "r")).rejects.toThrow();
  });

  it("refuses to complete a multipart upload with a missing part, and can abort it", async () => {
    const size = 101 * MIB;
    const src = await writeRandomFile("partial.bin", size);
    const { sha256 } = await sha256File(src);
    const plan = await store.createUpload({
      runId: "run-tdm32",
      trialId: "trial-5",
      name: "partial.bin",
      sizeBytes: size,
      sha256,
      maxBytes: 200 * MIB,
      partSizeBytes: 64 * MIB,
    });
    if (plan.kind !== "multipart") throw new Error("expected multipart");
    expect(plan.parts).toHaveLength(2);
    // Upload only the first part (bypass the whole-file size/hash checks by sending it directly).
    const fh = await open(src, "r");
    const part = plan.parts[0]!;
    const buf = Buffer.alloc(part.sizeBytes);
    await fh.read(buf, 0, part.sizeBytes, 0);
    await fh.close();
    const res = await fetch(part.url, { method: "PUT", body: buf });
    expect(res.ok).toBe(true);
    await expect(store.completeUpload(plan)).rejects.toMatchObject({ code: "size_mismatch" });
    await store.abortUpload(plan);
    await expect(store.head(plan.key)).resolves.toBeNull();
  }, 120_000);
});
