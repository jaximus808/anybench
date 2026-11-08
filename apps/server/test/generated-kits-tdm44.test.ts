// TDM-44 contract C1: generated kit directories and the file:// kits.files_url kitDraft stores.
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { kitFilesUrl } from "../src/orchestrator/advance.js";
import { generatedKitDir, generatedKitsRoot } from "../src/orchestrator/generated-kits.js";

const RUN = "0195f3a2-7c1e-7d3a-9b1c-1234567890ab";

describe("generated kit dirs (TDM-44 C1)", () => {
  it("defaults to ~/.anybench/generated-kits/<run_id>/v<n>", () => {
    expect(loadConfig({}).ANYBENCH_GENERATED_KITS_DIR).toBeUndefined();
    expect(generatedKitsRoot()).toBe(path.join(homedir(), ".anybench", "generated-kits"));
    expect(generatedKitDir({ runId: RUN, version: 2 })).toBe(
      path.join(homedir(), ".anybench", "generated-kits", RUN, "v2"),
    );
  });

  it("honours ANYBENCH_GENERATED_KITS_DIR", () => {
    const root = loadConfig({
      ANYBENCH_GENERATED_KITS_DIR: "/srv/kits",
    }).ANYBENCH_GENERATED_KITS_DIR;
    expect(generatedKitDir({ runId: RUN, version: 1, root })).toBe(`/srv/kits/${RUN}/v1`);
  });

  it("refuses run ids and versions that could escape the root", () => {
    expect(() => generatedKitDir({ runId: "../../etc", version: 1 })).toThrow();
    expect(() => generatedKitDir({ runId: RUN, version: 0 })).toThrow();
    expect(() => generatedKitDir({ runId: RUN, version: 1.5 })).toThrow();
  });
});

describe("kitFilesUrl (TDM-44 C1)", () => {
  it("files_dir → file:// url, which round-trips to the absolute dir", () => {
    const dir = "/tmp/kits with space/v1";
    const url = kitFilesUrl({ files_dir: dir, files_upload_id: "u1" });
    expect(url).toMatch(/^file:\/\//);
    expect(fileURLToPath(url!)).toBe(dir);
  });

  it("falls back to upload:<id>, else null", () => {
    expect(kitFilesUrl({ files_upload_id: "u1" })).toBe("upload:u1");
    expect(kitFilesUrl({})).toBeNull();
  });
});
