// worker-naive: the release layout guard and the content-addressed release id.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentRoleDirs, checkResourceSites, releaseId } from "../lib/worker-bundle.js";

describe("checkResourceSites", () => {
  const known = [
    'var BASE_RECIPES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "recipes");',
    'var DEFAULT_ROLES_DIR = fileURLToPath2(new URL("../", import.meta.url));',
    'return path12.resolve(path12.dirname(fileURLToPath3(import.meta.url)), "../../../../packages/runner/dist/bin");',
    "let dir = path13.dirname(fileURLToPath4(import.meta.url));",
    "const require = __anybenchCreateRequire(import.meta.url);",
  ].join("\n");

  it("accepts the sites the release layout serves", () => {
    expect(checkResourceSites(known)).toHaveLength(5);
  });

  it("fails the build on a new import.meta.url path", () => {
    expect(() =>
      checkResourceSites(`${known}\nconst x = new URL("../templates", import.meta.url);`),
    ).toThrow(/1 file path\(s\)/);
  });
});

describe("release layout helpers", () => {
  it("agent roles are the directories with a config.json", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-naive-agents-"));
    for (const d of ["understander", "dist", "src", "notes"]) mkdirSync(join(root, d));
    writeFileSync(join(root, "understander", "config.json"), "{}");
    writeFileSync(join(root, "dist", "config.json"), "{}");
    expect(agentRoleDirs(root)).toEqual(["understander"]);
  });

  it("the release id is content addressed and order independent", async () => {
    const a = { path: "dist/worker.js", mode: 0o644, bytes: Buffer.from("a") };
    const b = { path: "bin/runner", mode: 0o755, bytes: Buffer.from("b") };
    const id = await releaseId([a, b]);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await releaseId([b, a])).toBe(id);
    expect(await releaseId([a, { ...b, mode: 0o644 }])).not.toBe(id);
    expect(await releaseId([a, { ...b, bytes: Buffer.from("c") }])).not.toBe(id);
  });
});
