// TDM-218: localKitDir resolves a kit's files to a directory on this worker: file:// as is, an
// uploaded kit's artifact: tarball unpacked once into a cache keyed by the artifact key.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryComputerStore } from "@anybench/envs";
import { loadKit } from "@anybench/kit";
import { proofStore } from "../src/jobs/proof-runner.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  artifactKitKey,
  kitArtifactSource,
  localKitDir,
  type KitArtifactSource,
} from "../src/orchestrator/kit-files.js";
import { dirEntriesTdm217, fakeKitStoreTdm217, tgzTdm217 } from "./helpers/kit-upload-tdm217.js";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "tdm218-kit-files-"));
  temps.push(d);
  return d;
}

/** A fake store whose "tarball" is JSON {path: text}; unpack writes those files. */
function fakeSource(files: Record<string, string>, opts: { failUnpack?: boolean } = {}) {
  const reads: string[] = [];
  const source: KitArtifactSource = {
    async read(key) {
      reads.push(key);
      return new TextEncoder().encode(JSON.stringify(files));
    },
    async unpack(bytes, dir) {
      if (opts.failUnpack) throw new Error("unsafe_path: ../escape");
      const entries = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
      for (const [rel, text] of Object.entries(entries)) {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), text);
      }
    },
  };
  return { source, reads };
}

describe("localKitDir (TDM-218)", () => {
  it("file:// is the directory itself", async () => {
    const d = temp();
    expect(await localKitDir(pathToFileURL(d).href)).toEqual({ ok: true, dir: d });
  });

  it("an artifact: kit is unpacked once and reused", async () => {
    const cacheDir = temp();
    const { source, reads } = fakeSource({ "anybench.yaml": "schema_version: 2\n" });
    const url = "artifact:kits/files/owner/kit.tar.gz";
    expect(artifactKitKey(url)).toBe("kits/files/owner/kit.tar.gz");
    const a = await localKitDir(url, { cacheDir, artifacts: source });
    if (!a.ok) throw new Error(a.reason);
    expect(readFileSync(path.join(a.dir, "anybench.yaml"), "utf8")).toBe("schema_version: 2\n");
    expect(path.dirname(a.dir)).toBe(path.resolve(cacheDir));
    const b = await localKitDir(url, { cacheDir, artifacts: source });
    expect(b).toEqual(a);
    expect(reads).toEqual(["kits/files/owner/kit.tar.gz"]);
  });

  it("says why there are no files: none, an unknown scheme, no artifact store", async () => {
    expect(await localKitDir(null)).toMatchObject({ ok: false });
    expect(await localKitDir("upload:abc")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("neither file:// nor artifact:"),
    });
    expect(await localKitDir("artifact:kits/files/o/k.tar.gz")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("none is configured"),
    });
  });

  it("a bad archive throws and leaves nothing behind to be reused", async () => {
    const cacheDir = temp();
    const bad = fakeSource({}, { failUnpack: true });
    const url = "artifact:kits/files/owner/bad.tar.gz";
    await expect(localKitDir(url, { cacheDir, artifacts: bad.source })).rejects.toThrow(
      /unsafe_path/,
    );
    const good = fakeSource({ "anybench.yaml": "ok\n" });
    const r = await localKitDir(url, { cacheDir, artifacts: good.source });
    expect(r.ok).toBe(true);
    expect(good.reads).toHaveLength(1);
  });
});

describe("kitArtifactSource (TDM-218 over TDM-217's store and archive reader)", () => {
  it("an uploaded kit tarball comes back as a kit directory that loads", async () => {
    const example = fileURLToPath(new URL("../../../packages/kit/examples/cli/", import.meta.url));
    const store = fakeKitStoreTdm217();
    // Wrapped in one top-level directory, as `tar czf kit.tgz my-kit/` makes it: stripped.
    const tgz = tgzTdm217(dirEntriesTdm217(example, "my-kit"));
    const { key } = await store.putKitFiles(
      "0190f0f0-0000-7000-8000-00000000000a",
      "0190f0f0-0000-7000-8000-00000000000b",
      tgz,
    );
    const r = await localKitDir(`artifact:${key}`, {
      cacheDir: temp(),
      artifacts: kitArtifactSource(store),
    });
    if (!r.ok) throw new Error(r.reason);
    const kit = await loadKit(r.dir);
    expect(kit.spec.subject.name).toBe((await loadKit(example)).spec.subject.name);
    // A key that is not in the store says so instead of unpacking nothing.
    const gone = await localKitDir("artifact:kits/files/o/missing.tar.gz", {
      cacheDir: temp(),
      artifacts: kitArtifactSource(store),
    });
    expect(gone).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not in the artifact store"),
    });
  });

  it("a tarball with a path escaping the kit is refused", async () => {
    const store = fakeKitStoreTdm217();
    const tgz = tgzTdm217([{ name: "../escape.txt", data: Buffer.from("x") }]);
    const { key } = await store.putKitFiles(
      "0190f0f0-0000-7000-8000-00000000000a",
      "0190f0f0-0000-7000-8000-00000000000c",
      tgz,
    );
    await expect(
      localKitDir(`artifact:${key}`, { cacheDir: temp(), artifacts: kitArtifactSource(store) }),
    ).rejects.toThrow();
  });
});

describe("proof computers' rows (TDM-218 billing)", () => {
  const row = (id: string) => ({
    id,
    provider: "fake",
    providerId: null,
    runId: "0190f0f0-0000-7000-8000-0000000000aa",
    trialId: "0190f0f0-0000-7000-8000-0000000000bb",
    snapshotId: null,
    status: "creating" as const,
    createdAt: new Date(),
    destroyedAt: null,
    blocksBilled: 0,
    costMicroUsd: 0n,
    lastSeenAt: null,
  });

  it("an uploaded kit's proof computers carry the run id (billed with the run); ours carry none", async () => {
    const billed = new MemoryComputerStore();
    await proofStore(billed, "0190f0f0-0000-7000-8000-0000000000cc").insert(row("c1"));
    expect(billed.rows.get("c1")).toMatchObject({
      runId: "0190f0f0-0000-7000-8000-0000000000cc",
      trialId: null,
    });
    const ours = new MemoryComputerStore();
    await proofStore(ours, null).insert(row("c2"));
    expect(ours.rows.get("c2")).toMatchObject({ runId: null, trialId: null });
  });
});
