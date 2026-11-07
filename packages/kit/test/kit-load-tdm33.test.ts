// TDM-33 [4.1]: anybench.yaml loader, validator and folder layout.
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatKitIssue,
  hashKitPaths,
  KIT_LAYOUT,
  KitLoadError,
  loadKit,
  parseKitManifest,
  validateKitDir,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(here, "..", "examples");
const BROKEN = path.join(here, "fixtures", "kits-tdm33", "broken");
const BASE = path.join(BROKEN, "06-weights-sum"); // copied and repaired for tmp-dir tests

const tmpDirs: string[] = [];
async function tmpKit(from: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "anybench-kit-tdm33-"));
  tmpDirs.push(d);
  await cp(from, d, { recursive: true });
  return d;
}
/** A valid minimal kit: the weights-sum fixture with its one error fixed. */
async function validMinimalKit(): Promise<string> {
  const d = await tmpKit(BASE);
  await rm(path.join(d, "expected.txt"));
  const y = path.join(d, "anybench.yaml");
  await writeFile(y, (await readFile(y, "utf8")).replace("wall: 90", "wall: 100"));
  return d;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("example kits", async () => {
  const types = (await readdir(EXAMPLES, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it("ships at least the cli and harness examples", () => {
    expect(types).toEqual(expect.arrayContaining(["cli", "harness"]));
  });

  it.each(types)("examples/%s validates with no errors and no warnings", async (t) => {
    const r = await validateKitDir(path.join(EXAMPLES, t));
    expect(r.lines).toEqual([]);
    expect(r.warnings.map(formatKitIssue)).toEqual([]);
    expect(r.ok).toBe(true);
    // The example's driver types include its folder name.
    expect(r.kit?.spec.contenders.map((c) => c.driver.type)).toContain(t);
  });

  it("loadKit resolves layout defaults and hashes every workload", async () => {
    const kit = await loadKit(path.join(EXAMPLES, "cli"));
    expect(kit.contenders).toEqual([
      {
        id: "ripgrep",
        install: "adapters/ripgrep/install.sh",
        healthcheck: "adapters/ripgrep/healthcheck.sh",
        driver: "adapters/ripgrep/driver.sh",
      },
      {
        id: "gnu-grep",
        install: "adapters/gnu-grep/install.sh",
        driver: "adapters/gnu-grep/driver.sh",
      },
    ]);
    expect(kit.gates).toEqual([
      {
        id: "same-matches",
        check: "gates/same-matches/check.sh",
        reference: "reference/same-matches/",
      },
    ]);
    const lit = kit.workloads.find((w) => w.id === "literal-search");
    expect(lit?.files.map((f) => f.path)).toEqual([
      "workloads/literal-search/input/pattern.txt",
      "workloads/literal-search/input/tree/README",
      "workloads/literal-search/input/tree/src/power.c",
    ]);
    // The declared sha256 in the example matches.
    expect(lit?.sha256).toBe(kit.spec.workloads[0]?.sha256);
  });
});

describe("broken fixtures each fail with the expected message", async () => {
  const names = (await readdir(BROKEN)).sort();

  it("has at least 10 broken fixtures", () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it.each(names)("%s", async (name) => {
    const dir = path.join(BROKEN, name);
    const expected = (await readFile(path.join(dir, "expected.txt"), "utf8")).trimEnd().split("\n");
    const r = await validateKitDir(dir);
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual(expected);
    await expect(loadKit(dir)).rejects.toSatisfy(
      (e: unknown) => e instanceof KitLoadError && e.lines.join("\n") === expected.join("\n"),
    );
  });
});

describe("workload hashing is deterministic", () => {
  it("ignores mtimes, modes, copies and directory order; changes with bytes", async () => {
    const src = path.join(EXAMPLES, "cli");
    const a = await hashKitPaths(src, ["workloads/literal-search"]);
    const copy = await tmpKit(src);
    const f = path.join(copy, "workloads/literal-search/input/tree/README");
    await utimes(f, new Date(0), new Date(0));
    await chmod(f, 0o600);
    await writeFile(path.join(copy, "workloads/literal-search/input/.DS_Store"), "litter");
    const b = await hashKitPaths(copy, ["workloads/literal-search/"]);
    expect(b.hash.sha256).toBe(a.hash.sha256);
    expect(b.hash.manifest).toBe(a.hash.manifest);
    expect(a.hash.manifest.split("\n")[0]).toMatch(
      /^[a-f0-9]{64} {2}\d+ {2}workloads\/literal-search\/input\/pattern\.txt$/,
    );

    await writeFile(f, "Send PM_RESUME after wake.\n");
    const c = await hashKitPaths(copy, ["workloads/literal-search"]);
    expect(c.hash.sha256).not.toBe(a.hash.sha256);
  });

  it("rejects symlinks inside a workload", async () => {
    const d = await validMinimalKit();
    await symlink("/etc/hosts", path.join(d, "workloads/small/input/hosts"));
    const r = await validateKitDir(d);
    expect(r.errors.map((e) => e.code)).toEqual(["workload_symlink"]);
    expect(r.lines[0]).toMatch(
      /^anybench\.yaml:15:5: workloads\[0\]: workloads\/small\/input\/hosts is a symlink/,
    );
  });

  it("canonicalizes paths: ./workloads//small/input hashes like workloads/small/input", async () => {
    const d = await validMinimalKit();
    const a = await hashKitPaths(d, ["workloads/small/input"]);
    const b = await hashKitPaths(d, ["./workloads//small/input/", "workloads/small/input"]);
    expect(b.problems).toEqual([]);
    expect(b.hash.manifest).toBe(a.hash.manifest);
    expect(b.hash.sha256).toBe(a.hash.sha256);
    expect((await hashKitPaths(d, ["../x", "/etc"])).problems.map((p) => p.kind)).toEqual([
      "outside",
      "outside",
    ]);
  });
});

describe("symlinks that escape the kit", () => {
  async function outsideDir(): Promise<string> {
    const o = await mkdtemp(path.join(tmpdir(), "anybench-kit-tdm33-outside-"));
    tmpDirs.push(o);
    await mkdir(path.join(o, "small", "input"), { recursive: true });
    await writeFile(path.join(o, "small", "input", "secret.txt"), "outside bytes\n");
    return o;
  }

  it("refuses a symlinked workloads/ folder, in hashKitPaths and in validateKitDir", async () => {
    const d = await validMinimalKit();
    const o = await outsideDir();
    await rm(path.join(d, "workloads"), { recursive: true });
    await symlink(o, path.join(d, "workloads"));
    const h = await hashKitPaths(d, ["workloads/small"]);
    expect(h.problems).toEqual([{ kind: "outside", path: "workloads/small" }]);
    expect(h.hash.files).toEqual([]);
    const r = await validateKitDir(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => [e.code, e.path])).toEqual([["outside_kit", "workloads[0]"]]);
  });

  it("refuses a symlinked workloads/<id> parent of an explicit input", async () => {
    const d = await validMinimalKit();
    const o = await outsideDir();
    await rm(path.join(d, "workloads", "small"), { recursive: true });
    await symlink(path.join(o, "small"), path.join(d, "workloads", "small"));
    const y = path.join(d, "anybench.yaml");
    await writeFile(
      y,
      (await readFile(y, "utf8")).replace(
        "  - id: small\n",
        "  - id: small\n    input: workloads/small/input/\n",
      ),
    );
    const r = await validateKitDir(d);
    expect(r.errors.map((e) => [e.code, e.path])).toEqual([["outside_kit", "workloads[0].input"]]);
  });

  it("refuses escaping symlinks inside reference/, gates/<id>/reference and proof dirs; allows internal ones", async () => {
    const d = await validMinimalKit();
    const o = await outsideDir();
    const y = path.join(d, "anybench.yaml");
    await writeFile(
      y,
      (await readFile(y, "utf8")).replace(
        "    kind: output-diff\n",
        "    kind: output-diff\n  - id: other\n    kind: custom\n    reference: reference/\n",
      ),
    );
    await mkdir(path.join(d, "gates", "other"));
    await writeFile(path.join(d, "gates", "other", "check.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await mkdir(path.join(d, "reference", "deep"), { recursive: true });
    await writeFile(path.join(d, "reference", "a.txt"), "a\n");
    await symlink("../a.txt", path.join(d, "reference", "deep", "internal.txt")); // allowed
    await symlink(path.join(o, "small"), path.join(d, "reference", "deep", "leak"));
    await symlink(o, path.join(d, "gates", "same-output", "reference")); // default reference
    await symlink("/etc/hosts", path.join(d, "proof", "oracle", "hosts"));
    const r = await validateKitDir(d);
    expect(r.errors.map((e) => `${e.code} ${e.path}: ${e.message}`)).toEqual([
      expect.stringMatching(
        /^outside_kit gates\[0\]\.reference: gates\/same-output\/reference resolves outside the kit/,
      ),
      "outside_kit gates[1].reference: reference/deep/leak is a symlink that resolves outside the kit (or dangles)",
      "outside_kit proof.oracle.dir: proof/oracle/hosts is a symlink that resolves outside the kit (or dangles)",
    ]);
  });

  it("refuses a symlinked anybench.yaml", async () => {
    const d = await validMinimalKit();
    const o = await outsideDir();
    await cp(path.join(d, "anybench.yaml"), path.join(o, "anybench.yaml"));
    await rm(path.join(d, "anybench.yaml"));
    await symlink(path.join(o, "anybench.yaml"), path.join(d, "anybench.yaml"));
    const r = await validateKitDir(d);
    expect(r.errors.map((e) => e.code)).toEqual(["manifest_symlink"]);
  });
});

describe("file checks", () => {
  it("a minimal valid kit passes", async () => {
    const r = await validateKitDir(await validMinimalKit());
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("rejects a script that symlinks outside the kit", async () => {
    const d = await validMinimalKit();
    const drv = path.join(d, KIT_LAYOUT.driverScript("tool"));
    await rm(drv);
    await symlink("/bin/sh", drv);
    const r = await validateKitDir(d);
    expect(r.errors.map((e) => e.code)).toEqual(["outside_kit"]);
    expect(r.errors[0]?.path).toBe("contenders[0].driver.script");
  });

  it("checks explicit paths, rubric criteria and env fixtures", async () => {
    const d = await validMinimalKit();
    const y = path.join(d, "anybench.yaml");
    let text = await readFile(y, "utf8");
    text = text
      .replace(
        "  - id: small\n",
        "  - id: small\n    instruction: workloads/small/instruction.md\n",
      )
      .replace(
        "    gate_id: same-output\n",
        "    gate_id: same-output\n  - id: clarity\n    type: reviewed\n    title: Clear\n    criterion: Clarity of output\n",
      )
      .replace("wall: 100", "wall: 80, clarity: 20")
      .concat(
        "env:\n  profile: base\n  resources: { vcpu: 2, memory_gb: 4, disk_gb: 20 }\n  fixtures: [{ src: data/missing.bin, dest: /home/naive/in }]\n",
      );
    await writeFile(y, text);
    await writeFile(path.join(d, "rubric.md"), "# Rubric\n\n## Speed\n");
    const r = await validateKitDir(d);
    expect(r.errors.map((e) => [e.code, e.path])).toEqual([
      ["missing_file", "workloads[0].instruction"],
      ["rubric_criterion_missing", "requirements[1].criterion"],
      ["missing_file", "env.fixtures[0].src"],
    ]);
  });

  it("warns on non-executable scripts, unused folders and misplaced proof overlays", async () => {
    const d = await validMinimalKit();
    await chmod(path.join(d, KIT_LAYOUT.installScript("tool")), 0o644);
    await mkdir(path.join(d, "adapters/ghost"));
    await mkdir(path.join(d, "elsewhere"));
    await writeFile(path.join(d, "elsewhere/x"), "x");
    const y = path.join(d, "anybench.yaml");
    await writeFile(
      y,
      (await readFile(y, "utf8")).replace("dir: proof/oracle/", "dir: elsewhere/"),
    );
    const r = await validateKitDir(d);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code).sort()).toEqual([
      "not_executable",
      "proof_dir_misplaced",
      "unused_dir",
    ]);
    expect(r.warnings.map(formatKitIssue)).toContain(
      "adapters/ghost/: no contender has id 'ghost'",
    );
  });

  it("reports a missing kit dir and a missing anybench.yaml", async () => {
    const r1 = await validateKitDir(path.join(tmpdir(), "anybench-kit-tdm33-does-not-exist"));
    expect(r1.errors.map((e) => e.code)).toEqual(["kit_dir_missing"]);
    const d = await mkdtemp(path.join(tmpdir(), "anybench-kit-tdm33-"));
    tmpDirs.push(d);
    const r2 = await validateKitDir(d);
    expect(r2.lines).toEqual([`anybench.yaml: not found in ${d}`]);
  });
});

describe("parseKitManifest maps schema paths to LINE:COL", () => {
  it("points an unrecognized nested key at the key itself", () => {
    const text = (src: string) => parseKitManifest(src).errors.map(formatKitIssue);
    const yaml = [
      "schema_version: 2",
      "subject: { kind: software, name: x, summary: y, better_means: [z] }",
      "contenders:",
      "  - id: a",
      "    role: subject",
      "    source: { github: o/r, ref: main }",
      "    driver:",
      "      type: cli",
      "      verbs: { run: go }",
      "      wall_clock: 5",
      "workloads: [{ id: w }]",
      "requirements: [{ id: r, type: reviewed, title: t }]",
      "scoring: { weights: { r: 100 } }",
      "repeats: 1",
    ].join("\n");
    expect(text(yaml)).toEqual([
      'anybench.yaml:10:7: contenders[0].driver: Unrecognized key: "wall_clock"',
    ]);
  });

  it("reports duplicate keys as YAML errors", () => {
    const dup = parseKitManifest("schema_version: 2\nschema_version: 2\n");
    expect(dup.errors[0]?.code).toBe("yaml_syntax");
    expect(dup.errors[0]?.line).toBe(2);
  });
});
