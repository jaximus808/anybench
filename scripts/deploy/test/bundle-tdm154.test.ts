// TDM-154: the API bundle. Workspace code is inlined, npm packages stay external at the version
// this checkout resolves, and the file map hashes deterministically.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundleApi,
  contentHashOf,
  packageName,
  pickVersions,
  resolvedVersion,
} from "../lib/bundle.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tdm154-bundle-"));
  const pkg = (dir: string, name: string, version: string, main = "index.js", body = "") => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version, type: "module", main, exports: { ".": `./${main}` } }),
    );
    writeFileSync(join(dir, main), body || `export const v = ${JSON.stringify(version)};`);
  };
  // An npm package with exports that hide package.json, and a workspace package that uses another.
  pkg(join(root, "node_modules", "left-pad-tdm154"), "left-pad-tdm154", "1.3.0");
  pkg(
    join(root, "node_modules", "@anybench", "util-tdm154"),
    "@anybench/util-tdm154",
    "0.0.0",
    "index.js",
    'import { v } from "@scope-tdm154/dep/sub"; export const util = () => "util:" + v;',
  );
  pkg(join(root, "node_modules", "@scope-tdm154", "dep"), "@scope-tdm154/dep", "2.0.1", "sub.js");
  writeFileSync(
    join(root, "entry.js"),
    [
      'import { v } from "left-pad-tdm154";',
      'import { util } from "@anybench/util-tdm154";',
      'import { createHash } from "node:crypto";',
      "export default () => [v, util(), createHash('sha1').digest('hex')];",
    ].join("\n"),
  );
  return root;
}

describe("bundle helpers (TDM-154)", () => {
  it("packageName strips subpaths, keeping scopes", () => {
    expect(packageName("hono/cookie")).toBe("hono");
    expect(packageName("@hono/node-server")).toBe("@hono/node-server");
    expect(packageName("@aws-sdk/client-s3/dist/x")).toBe("@aws-sdk/client-s3");
  });

  it("pickVersions takes the highest same-major version and refuses a major split", () => {
    const ok = pickVersions(new Map([["zod", new Set(["4.6.7", "4.10.0"])]]));
    expect(ok.dependencies).toEqual({ zod: "4.10.0" });
    expect(ok.warnings).toHaveLength(1);
    expect(() => pickVersions(new Map([["zod", new Set(["3.25.0", "4.6.7"])]]))).toThrow(
      /incompatible/,
    );
  });

  it("contentHashOf is order-independent and content-sensitive", () => {
    const a = { "a.js": Buffer.from("1"), "b.js": Buffer.from("2") };
    const b = { "b.js": Buffer.from("2"), "a.js": Buffer.from("1") };
    expect(contentHashOf(a)).toBe(contentHashOf(b));
    expect(contentHashOf(a)).not.toBe(contentHashOf({ ...a, "a.js": Buffer.from("3") }));
  });
});

describe("bundleApi (TDM-154)", () => {
  it("inlines @anybench/*, externalizes npm packages at their resolved versions", async () => {
    const root = fixture();
    expect(resolvedVersion("@scope-tdm154/dep", root)).toBe("2.0.1");
    const out = await bundleApi({
      entry: join(root, "entry.js"),
      vercelJson: { rewrites: [] },
    });
    expect(out.dependencies).toEqual({ "@scope-tdm154/dep": "2.0.1", "left-pad-tdm154": "1.3.0" });
    const js = out.files["api/app.js"]!.toString("utf8");
    expect(js).toContain('"util:"');
    expect(js).toContain('from "left-pad-tdm154"');
    expect(js).toContain('from "@scope-tdm154/dep/sub"');
    expect(js).toContain('from "node:crypto"');
    expect(JSON.parse(out.files["package.json"]!.toString("utf8"))).toEqual({
      name: "anybench-api",
      private: true,
      type: "module",
      engines: { node: "22.x" },
      dependencies: out.dependencies,
    });
    expect(out.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const again = await bundleApi({ entry: join(root, "entry.js"), vercelJson: { rewrites: [] } });
    expect(again.contentHash).toBe(out.contentHash);
  });
});
