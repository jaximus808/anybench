// TDM-33 [4.1]: `anybench kit validate [dir]`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseKitValidateArgs, runKitValidate } from "../src/commands/kit-validate.js";

const kitPkg = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "kit",
);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
  };
}

describe("anybench kit validate", () => {
  it("parses [dir] and flags", () => {
    expect(parseKitValidateArgs([])).toEqual({ dir: ".", json: false, quiet: false, help: false });
    expect(parseKitValidateArgs(["kits/a", "--json"])).toMatchObject({ dir: "kits/a", json: true });
    expect(parseKitValidateArgs(["a", "b"])).toEqual({ error: "unexpected argument: b" });
    expect(parseKitValidateArgs(["--nope"])).toEqual({ error: "unknown option: --nope" });
  });

  it("exits 0 on a valid example and prints workload hashes", async () => {
    const c = capture();
    expect(await runKitValidate([path.join(kitPkg, "examples", "cli")], c.io)).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out[0]).toMatch(
      /^ok .*: ripgrep \(2 contenders, 2 workloads, 1 gates, 2 requirements\)$/,
    );
    expect(c.out[1]).toMatch(/workload literal-search {2}sha256 [a-f0-9]{64}/);
  });

  it("exits 1 with file:line errors on a broken kit", async () => {
    const c = capture();
    const dir = path.join(kitPkg, "test", "fixtures", "kits-tdm33", "broken", "04-undefined-gate");
    expect(await runKitValidate([dir], c.io)).toBe(1);
    expect(c.err[0]).toBe(
      "anybench.yaml:25:14: requirements[0].gate_id: gate 'same-outptu' is not defined in gates[]",
    );
  });

  it("--json prints a parseable result", async () => {
    const c = capture();
    expect(await runKitValidate([path.join(kitPkg, "examples", "harness"), "--json"], c.io)).toBe(
      0,
    );
    const j = JSON.parse(c.out.join("\n")) as { ok: boolean; kit: { workloads: { id: string }[] } };
    expect(j.ok).toBe(true);
    expect(j.kit.workloads.map((w) => w.id)).toEqual(["todo-api", "bug-hunt"]);
  });

  it("exits 2 on a usage error", async () => {
    const c = capture();
    expect(await runKitValidate(["a", "b"], c.io)).toBe(2);
  });
});
