import { describe, expect, it } from "vitest";
import {
  ArtifactStore,
  ArtifactTransferError,
  MIB,
  MULTIPART_THRESHOLD_BYTES,
  planParts,
  s3ConfigFromEnv,
  trialArtifactKey,
  trialPrefix,
  uploadPlanSchema,
} from "../src/storage.js";

const tdm32Config = {
  endpoint: "https://ewr1.vultrobjects.com",
  region: "ewr1",
  bucket: "anybench-artifacts",
  accessKeyId: "AKIDTDM32EXAMPLE",
  secretAccessKey: "tdm32-not-a-real-secret",
};
const tdm32Sha = "a".repeat(64);

describe("storage keys", () => {
  it("builds runs/<run>/trials/<trial>/ keys", () => {
    expect(trialPrefix("run_1", "t-07")).toBe("runs/run_1/trials/t-07/");
    expect(trialArtifactKey("run_1", "t-07", "out/scrollback.txt")).toBe(
      "runs/run_1/trials/t-07/out/scrollback.txt",
    );
  });

  it.each(["../x", "a/../b", "/abs", "a//b", "a/./b", "sp ace", ""])("rejects name %j", (name) => {
    expect(() => trialArtifactKey("r", "t", name)).toThrow();
  });

  it.each(["..", "a/b", ".hidden", ""])("rejects id %j", (id) => {
    expect(() => trialPrefix(id, "t")).toThrow();
    expect(() => trialPrefix("r", id)).toThrow();
  });
});

describe("s3ConfigFromEnv", () => {
  it("reads the S3_* vars and defaults to path-style", () => {
    const cfg = s3ConfigFromEnv({
      S3_ENDPOINT: tdm32Config.endpoint,
      S3_REGION: tdm32Config.region,
      S3_BUCKET: tdm32Config.bucket,
      S3_ACCESS_KEY_ID: tdm32Config.accessKeyId,
      S3_SECRET_ACCESS_KEY: tdm32Config.secretAccessKey,
    });
    expect(cfg).toEqual({ ...tdm32Config, forcePathStyle: true });
  });

  it("names missing vars without echoing values", () => {
    try {
      s3ConfigFromEnv({
        S3_ENDPOINT: tdm32Config.endpoint,
        S3_SECRET_ACCESS_KEY: tdm32Config.secretAccessKey,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactTransferError);
      const msg = (err as Error).message;
      expect(msg).toContain("S3_REGION");
      expect(msg).toContain("S3_BUCKET");
      expect(msg).toContain("S3_ACCESS_KEY_ID");
      expect(msg).not.toContain(tdm32Config.secretAccessKey);
    }
  });
});

describe("planParts", () => {
  it("splits 200 MiB into 16 MiB parts with a short tail", () => {
    const parts = planParts(200 * MIB);
    expect(parts).toHaveLength(13);
    expect(parts[0]).toEqual({ partNumber: 1, offset: 0, sizeBytes: 16 * MIB });
    expect(parts.at(-1)).toEqual({ partNumber: 13, offset: 192 * MIB, sizeBytes: 8 * MIB });
    expect(parts.reduce((n, p) => n + p.sizeBytes, 0)).toBe(200 * MIB);
  });

  it("never exceeds 10,000 parts and never goes under 5 MiB", () => {
    expect(planParts(200 * 1024 * MIB, 5 * MIB).length).toBeLessThanOrEqual(10_000);
    expect(planParts(20 * MIB, 1)[0]?.sizeBytes).toBe(5 * MIB);
  });
});

describe("ArtifactStore.createUpload (offline)", () => {
  const store = new ArtifactStore(tdm32Config, { now: () => new Date("2026-11-07T00:00:00Z") });

  it("refuses files over the cap before touching S3", async () => {
    await expect(
      store.createUpload({
        runId: "r",
        trialId: "t",
        name: "big.bin",
        sizeBytes: 11,
        sha256: tdm32Sha,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("presigns a single path-style PUT with content-length signed and sha256 recorded", async () => {
    const plan = await store.createUpload({
      runId: "r1",
      trialId: "t1",
      name: "out/log.txt",
      sizeBytes: 1234,
      sha256: tdm32Sha,
      maxBytes: MULTIPART_THRESHOLD_BYTES,
      expiresInSec: 600,
    });
    expect(uploadPlanSchema.parse(plan)).toEqual(plan);
    if (plan.kind !== "single") throw new Error("expected single");
    const url = new URL(plan.url);
    expect(url.host).toBe("ewr1.vultrobjects.com");
    expect(url.pathname).toBe("/anybench-artifacts/runs/r1/trials/t1/out/log.txt");
    const signed = url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
    expect(signed).toEqual(expect.arrayContaining(["content-length", "host", "x-amz-meta-sha256"]));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.search).not.toContain(tdm32Config.secretAccessKey);
    expect(plan.headers).toEqual({ "content-length": "1234", "x-amz-meta-sha256": tdm32Sha });
    expect(plan.expiresAt).toBe("2026-11-07T00:10:00.000Z");
  });
});
