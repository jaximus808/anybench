// @anybench/core runs in the browser too (apps/web imports it via lib/api.ts), so its source must
// not import Node built-ins: one `node:` import drags a large polyfill into every client bundle.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("core is browser-safe (TDM-98)", () => {
  it("has no node: imports in src/", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((f) =>
      /(?:from\s+|import\s*\(\s*|import\s+)["']node:/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
