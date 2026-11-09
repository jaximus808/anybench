// TDM-217 [19.1]: kit upload keys and presigned PUTs (offline: presigning needs no network).
import { describe, expect, it } from "vitest";
import { ArtifactStore, ArtifactTransferError, kitFilesKey, kitUploadKey } from "../src/storage.js";

const config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "anybench-artifacts",
  accessKeyId: "AKIDTDM217EXAMPLE",
  secretAccessKey: "tdm217-not-a-real-secret",
};
const owner = "0190f0f0-0000-7000-8000-00000000000a";
const upload = "0190f0f0-0000-7000-8000-00000000000b";

describe("kit keys (TDM-217)", () => {
  it("keeps uploads and stored kits apart, outside every runs/ prefix", () => {
    expect(kitUploadKey(owner, upload)).toBe(`kits/uploads/${owner}/${upload}.tar.gz`);
    expect(kitFilesKey(owner, upload)).toBe(`kits/files/${owner}/${upload}.tar.gz`);
  });

  it.each(["..", "a/b", "", ".x"])("rejects id %j", (id) => {
    expect(() => kitUploadKey(id, upload)).toThrow();
    expect(() => kitUploadKey(owner, id)).toThrow();
    expect(() => kitFilesKey(id, upload)).toThrow();
  });
});

describe("ArtifactStore kit uploads (TDM-217)", () => {
  const store = new ArtifactStore(config, { now: () => new Date("2026-11-08T00:00:00Z") });

  it("signs one PUT for exactly the declared length and sha256", async () => {
    const put = await store.createKitUpload({
      ownerId: owner,
      uploadId: upload,
      sizeBytes: 1234,
      sha256: "c".repeat(64),
      maxBytes: 50 * 1024 * 1024,
      expiresInSec: 3600,
    });
    expect(put.key).toBe(kitUploadKey(owner, upload));
    expect(put.url).toContain(`/anybench-artifacts/kits/uploads/${owner}/${upload}.tar.gz`);
    expect(new URL(put.url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(put.headers).toMatchObject({
      "content-length": "1234",
      "x-amz-meta-sha256": "c".repeat(64),
      "x-amz-checksum-sha256": Buffer.from("c".repeat(64), "hex").toString("base64"),
    });
    expect(put.expiresAt).toBe("2026-11-08T01:00:00.000Z");
  });

  it("refuses a tarball over the cap", async () => {
    await expect(
      store.createKitUpload({
        ownerId: owner,
        uploadId: upload,
        sizeBytes: 11,
        sha256: "c".repeat(64),
        maxBytes: 10,
        expiresInSec: 60,
      }),
    ).rejects.toBeInstanceOf(ArtifactTransferError);
  });

  it("downloads only stored kit keys", async () => {
    for (const key of [
      kitUploadKey(owner, upload),
      "runs/r/trials/t/out.tar.gz",
      `kits/files/${owner}/../x.tar.gz`,
    ]) {
      await expect(store.createKitDownload(key)).rejects.toMatchObject({ code: "not_found" });
    }
  });
});
