// TDM-219 [19.3]: the bring-your-own-kit helpers the CLI and the MCP server share: scaffoldKit,
// packKit / inspectKitArchive, and the local proof (plan, scripts, evaluation; the Docker run
// itself skips cleanly without a Docker daemon).
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { dockerLocalAvailable } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KIT_ARCHIVE_LIMITS,
  KIT_TEMPLATES,
  KitArchiveError,
  KitScaffoldError,
  LocalProofError,
  LocalProofResultSchema,
  evaluateLocalProof,
  inspectKitArchive,
  judgeGateRecord,
  packKit,
  planLocalProof,
  readLocalProofRecords,
  renderLocalProofGateScript,
  renderLocalProofTrialScript,
  runLocalProof,
  scaffoldKit,
  validateKitDir,
  type LocalProofPlan,
  type LocalProofUnitRecord,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(here, "..", "examples");

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "ab-tdm219-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function freshKit(name: string, template?: (typeof KIT_TEMPLATES)[number]) {
  const dir = path.join(tmp, name);
  await scaffoldKit(dir, template ? { template } : {});
  return dir;
}

// ---------------------------------------------------------------------------------------------

describe("scaffoldKit (TDM-219)", () => {
  it.each(KIT_TEMPLATES)("the %s template scaffolds a kit that validates", async (t) => {
    const dir = path.join(tmp, `scaffold-${t}`);
    const r = await scaffoldKit(dir, { template: t });
    expect(r.template).toBe(t);
    expect(r.files).toContain("anybench.yaml");
    const v = await validateKitDir(dir);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("defaults to coding-agent with the KitSpec v2 layout, headers and exec bits", async () => {
    const dir = await freshKit("scaffold-default");
    const yaml = await readFile(path.join(dir, "anybench.yaml"), "utf8");
    expect(
      yaml.startsWith("# Scaffolded by `anybench kit init` from the coding-agent example"),
    ).toBe(true);
    expect(yaml).toContain("schema_version: 2");
    expect(yaml).not.toContain("regenerate them rather than editing by hand");
    for (const p of [
      "workloads/slugify/instruction.md",
      "workloads/slugify/input/src/slug.js",
      "workloads/slugify/setup.sh",
      "gates/hidden-tests/check.sh",
      "proof/oracle/driver.sh",
      "proof/do_less/skip-tests/driver.sh",
    ]) {
      expect((await stat(path.join(dir, p))).isFile()).toBe(true);
    }
    expect((await stat(path.join(dir, "workloads/slugify/setup.sh"))).mode & 0o111).not.toBe(0);
    expect((await stat(path.join(dir, "gates/hidden-tests/check.sh"))).mode & 0o111).not.toBe(0);
  });

  it("refuses a non-empty directory unless force, and an unknown template", async () => {
    const dir = path.join(tmp, "scaffold-busy");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "notes.txt"), "mine\n");
    await expect(scaffoldKit(dir)).rejects.toThrow(KitScaffoldError);
    await expect(scaffoldKit(dir, { force: true })).resolves.toMatchObject({
      template: "coding-agent",
    });
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("mine\n");
    await expect(
      scaffoldKit(path.join(tmp, "scaffold-x"), { template: "nope" as never }),
    ).rejects.toThrow(/unknown template 'nope'/);
  });
});

// ---------------------------------------------------------------------------------------------
// a raw tar writer for crafted (hostile) archives

function rawTar(entries: { name: string; type?: string; data?: string; link?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.fill(0x20, 148, 156);
    h.write(e.type ?? "0", 156, 1);
    if (e.link) h.write(e.link, 157, 100);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

describe("packKit / inspectKitArchive (TDM-219)", () => {
  it("packs a scaffold deterministically, keeping exec bits, and passes its own inspection", async () => {
    const dir = await freshKit("pack-a");
    const a = await packKit(dir);
    const b = await packKit(dir);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.paths).toContain("anybench.yaml");
    const i = inspectKitArchive(a.bytes);
    expect(i.problems).toEqual([]);
    expect(i.files).toBe(a.files);
    expect(i.unpackedBytes).toBe(a.unpackedBytes);
    const setup = i.entries.find((e) => e.path === "workloads/slugify/setup.sh")!;
    expect(setup.mode).toBe(0o755);
    expect(i.entries.find((e) => e.path === "workloads/slugify/instruction.md")!.mode).toBe(0o644);
    expect(i.entries.find((e) => e.path === "workloads/slugify/input")!.type).toBe("dir");
  });

  it("skips .git, packs an in-kit file symlink as the file, refuses escaping symlinks", async () => {
    const dir = await freshKit("pack-links");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await symlink("rubric-src.md", path.join(dir, "notes.md"));
    await writeFile(path.join(dir, "rubric-src.md"), "# notes\n");
    const p = await packKit(dir);
    expect(p.paths).toContain("notes.md");
    expect(p.paths.some((x) => x.startsWith(".git"))).toBe(false);
    expect(inspectKitArchive(p.bytes).entries.every((e) => e.type !== ("link" as never))).toBe(
      true,
    );

    await symlink("/etc/hosts", path.join(dir, "escape"));
    const err = await packKit(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitArchiveError);
    expect((err as KitArchiveError).problems.map((x) => x.code)).toEqual(["link_entry"]);
  });

  it("refuses a kit over the size or entry caps", async () => {
    const dir = await freshKit("pack-big");
    await expect(packKit(dir, { limits: { maxUnpackedBytes: 1000 } })).rejects.toThrow(
      /more than 1000 bytes/,
    );
    await expect(packKit(dir, { limits: { maxEntries: 3 } })).rejects.toThrow(/more than 3/);
  });

  const manifest = { name: "anybench.yaml", data: "schema_version: 2\n" };
  it.each([
    ["parent_path", [manifest, { name: "../evil.sh", data: "x" }]],
    ["parent_path", [manifest, { name: "a/../../evil.sh", data: "x" }]],
    ["absolute_path", [manifest, { name: "/etc/cron.d/x", data: "x" }]],
    ["link_entry", [manifest, { name: "l", type: "2", link: "/etc/passwd" }]],
    ["link_entry", [manifest, { name: "h", type: "1", link: "anybench.yaml" }]],
    ["special_entry", [manifest, { name: "dev", type: "3" }]],
    ["duplicate_path", [manifest, { name: "./anybench.yaml", data: "y" }]],
    ["manifest_missing", [{ name: "README.md", data: "x" }]],
  ] as const)("refuses a crafted archive: %s", (code, entries) => {
    const r = inspectKitArchive(rawTar([...entries]));
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain(code);
  });

  it("refuses non-gzip, over-size and too-many-entries archives", () => {
    expect(inspectKitArchive(Buffer.from("plain text")).problems[0]!.code).toBe("not_gzip");
    const ok = rawTar([manifest]);
    expect(inspectKitArchive(ok).ok).toBe(true);
    expect(inspectKitArchive(ok, { maxArchiveBytes: 10 }).problems[0]!.code).toBe(
      "archive_too_large",
    );
    const many = rawTar([manifest, ...Array.from({ length: 5 }, (_, i) => ({ name: `f${i}` }))]);
    expect(inspectKitArchive(many, { maxEntries: 3 }).problems.map((p) => p.code)).toContain(
      "too_many_entries",
    );
    const big = rawTar([manifest, { name: "big", data: "x".repeat(5000) }]);
    expect(inspectKitArchive(big, { maxUnpackedBytes: 1000 }).ok).toBe(false);
    expect(KIT_ARCHIVE_LIMITS.maxArchiveBytes).toBe(50 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------------------------

describe("local proof: plan, scripts and result parsing (TDM-219, no Docker)", () => {
  let plan: LocalProofPlan;
  beforeAll(async () => {
    const v = await validateKitDir(await freshKit("plan"));
    plan = planLocalProof(v.kit!);
  });

  it("plans the coding-agent oracle as a driver_patch over the contender's driver", () => {
    expect(plan.oracle).toMatchObject({
      overlayId: "reference-solution",
      contenderId: "claude-code",
      driver: "adapters/claude-code/driver.sh",
      driverPatch: "proof/oracle/driver.sh",
      overlayDir: "proof/oracle",
      gates: ["hidden-tests"],
    });
    expect(plan.oracle.verbs.run).toBe(
      'adapters/claude-code/driver.sh run "$EVAL_IN/instruction.md" "$EVAL_WS"',
    );
    expect(plan.oracle.env.CLAUDE_CODE_VERSION).toBe("2.1.319");
    expect(plan.workloads).toEqual([
      {
        id: "slugify",
        input: "workloads/slugify/input",
        instruction: "workloads/slugify/instruction.md",
        setup: "workloads/slugify/setup.sh",
        timeoutS: 1800,
      },
    ]);
    expect(plan.gates).toEqual([
      { id: "hidden-tests", check: "gates/hidden-tests/check.sh", timeoutS: 600 },
    ]);
  });

  it("refuses an oracle with no driver_patch as not runnable locally", async () => {
    const v = await validateKitDir(path.join(EXAMPLES, "cli"));
    expect(() => planLocalProof(v.kit!)).toThrow(LocalProofError);
    expect(() => planLocalProof(v.kit!)).toThrow(/has no driver_patch/);
  });

  it("renders both scripts as valid bash", () => {
    for (const s of [renderLocalProofTrialScript(plan), renderLocalProofGateScript(plan)]) {
      const r = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }
    const trial = renderLocalProofTrialScript(plan);
    expect(trial).toContain("trial 'oracle' 'slugify'");
    expect(trial).toContain("trial 'do-nothing' 'slugify'");
    expect(trial).toContain("export CLAUDE_CODE_VERSION='2.1.319'");
    const gate = renderLocalProofGateScript(plan);
    expect(gate).toContain(
      "gate 'oracle' 'slugify' 'hidden-tests' 'gates/hidden-tests/check.sh' 600",
    );
    expect(gate).toContain("gate 'do-nothing' 'slugify' 'hidden-tests'");
  });

  const verdict = (pass: boolean, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ pass, reason: pass ? "7/7 pass" : "0/7 pass", evidence: [], ...extra });
  const unit = (
    variant: "oracle" | "do-nothing",
    gate: { checkExit?: number | null; gateJson?: string | null },
    over: Partial<LocalProofUnitRecord> = {},
  ): LocalProofUnitRecord => ({
    variant,
    workloadId: "slugify",
    setupExit: 0,
    driverExit: variant === "oracle" ? 0 : null,
    log: "",
    gates: [
      {
        gateId: "hidden-tests",
        checkExit: gate.checkExit === undefined ? 0 : gate.checkExit,
        gateJson: gate.gateJson === undefined ? null : gate.gateJson,
        log: "",
      },
    ],
    ...over,
  });

  it("judges gate records: pass, fail, not applicable, no verdict", () => {
    const g = (gateJson: string | null, checkExit: number | null = 0) =>
      judgeGateRecord({ gateId: "g", checkExit, gateJson, log: "" }).status;
    expect(g(verdict(true))).toBe("pass");
    expect(g(verdict(false))).toBe("fail");
    expect(g(verdict(false, { applicable: false }))).toBe("not_applicable");
    expect(g(null, 2)).toBe("no_verdict");
    expect(g("{not json", 0)).toBe("no_verdict");
    expect(g(JSON.stringify({ pass: "yes" }))).toBe("no_verdict");
    expect(g(verdict(true), null)).toBe("no_verdict");
  });

  it("passes when the oracle passes and do-nothing fails", () => {
    const checks = evaluateLocalProof(plan, [
      unit("oracle", { gateJson: verdict(true) }),
      unit("do-nothing", { gateJson: verdict(false) }),
    ]);
    expect(checks.map((c) => [c.check, c.pass])).toEqual([
      ["oracle_passes", true],
      ["do_nothing_fails", true],
    ]);
    expect(checks[1]!.units[0]!.reason).toBe("do-nothing failed 'hidden-tests' on slugify");
  });

  it("fails each check for the right reason", () => {
    const [o1, d1] = evaluateLocalProof(plan, [
      unit("oracle", { gateJson: verdict(false) }),
      unit("do-nothing", { gateJson: verdict(true) }),
    ]);
    expect(o1!.pass).toBe(false);
    expect(o1!.units[0]!.reason).toBe("oracle failed 'hidden-tests' on slugify: 0/7 pass");
    expect(d1!.pass).toBe(false);
    expect(d1!.units[0]!.reason).toMatch(/^do-nothing passed every gate on slugify/);

    const [o2, d2] = evaluateLocalProof(plan, [
      unit("oracle", { gateJson: verdict(true) }, { driverExit: 2 }),
      unit("do-nothing", { checkExit: 2, gateJson: null }),
    ]);
    expect(o2!.units[0]!.reason).toBe("oracle slugify: the oracle driver exited 2");
    // A check that broke proves nothing about the do-nothing.
    expect(d2!.pass).toBe(false);
    expect(d2!.units[0]!.reason).toMatch(/wrote no gate\.json \(exit 2\)/);

    const [o3, d3] = evaluateLocalProof(plan, [
      unit("oracle", {}, { setupExit: 1 }),
      unit("do-nothing", { gateJson: verdict(false, { applicable: false }) }),
    ]);
    expect(o3!.units[0]!.reason).toBe("oracle slugify: the workload's setup failed (exit 1)");
    expect(d3!.units[0]!.reason).toBe("do-nothing slugify: no gate applies");

    const [o4] = evaluateLocalProof(plan, []);
    expect(o4!.units[0]!.reason).toBe("oracle slugify: never ran");
  });

  it("reads the records the scripts write", async () => {
    const out = path.join(tmp, "records");
    const u = path.join(out, "units", "oracle", "slugify");
    await mkdir(path.join(u, "gates", "hidden-tests"), { recursive: true });
    await writeFile(path.join(u, "setup.exit"), "0\n");
    await writeFile(path.join(u, "driver.exit"), "0\n");
    await writeFile(path.join(u, "trial.log"), "ok\n");
    await writeFile(path.join(u, "gates", "hidden-tests", "check.exit"), "0\n");
    await writeFile(path.join(u, "gates", "hidden-tests", "gate.json"), verdict(true));
    const recs = await readLocalProofRecords(out, plan);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ variant: "oracle", setupExit: 0, driverExit: 0, log: "ok\n" });
    expect(recs[0]!.gates[0]).toMatchObject({ checkExit: 0, gateJson: verdict(true) });
    expect(recs[1]).toMatchObject({ variant: "do-nothing", setupExit: null, driverExit: null });
    const checks = evaluateLocalProof(plan, recs);
    expect(checks[0]!.pass).toBe(true);
    expect(checks[1]!.units[0]!.reason).toBe("do-nothing slugify: never ran");
  });

  it("returns invalid_kit and not_runnable as results, before touching Docker", async () => {
    const bad = path.join(tmp, "not-a-kit");
    await mkdir(bad, { recursive: true });
    const r1 = await runLocalProof(bad, { dockerBin: "/nonexistent/docker" });
    expect(LocalProofResultSchema.parse(r1)).toMatchObject({ ok: false, status: "error" });
    expect(r1.error!.code).toBe("invalid_kit");
    const r2 = await runLocalProof(path.join(EXAMPLES, "cli"), {
      dockerBin: "/nonexistent/docker",
    });
    expect(r2.error!.code).toBe("not_runnable");
    const r3 = await runLocalProof(await freshKit("no-docker"), {
      dockerBin: "/nonexistent/docker",
    });
    expect(r3.error!.code).toBe("docker_unavailable");
  });
});

// ---------------------------------------------------------------------------------------------

const docker = await dockerLocalAvailable();

describe.skipIf(!docker)("local proof in Docker (TDM-219)", () => {
  it("a fresh coding-agent scaffold passes both checks", async () => {
    const lines: string[] = [];
    const r = await runLocalProof(await freshKit("docker-ok"), { onLog: (l) => lines.push(l) });
    expect(LocalProofResultSchema.parse(r)).toEqual(r);
    expect(r.error).toBeNull();
    expect(r.checks.map((c) => [c.check, c.pass])).toEqual([
      ["oracle_passes", true],
      ["do_nothing_fails", true],
    ]);
    expect(r).toMatchObject({ ok: true, status: "pass", image: "node:22", outDir: null });
    expect(r.checks[0]!.units[0]!.gates[0]!.reason).toBe(
      "hidden-tests: 7/7 hidden tests pass on slugify",
    );
    expect(lines).toContain("[proof] oracle slugify: gate hidden-tests");
  }, 300_000);

  it("catches an oracle that solves nothing and a workload that starts solved", async () => {
    const dir = await freshKit("docker-bad");
    // The oracle applies nothing: it only freezes the starting workspace.
    const drv = path.join(dir, "proof", "oracle", "driver.sh");
    const src = await readFile(drv, "utf8");
    await writeFile(drv, src.replace('cp -R "$overlay/." "$ws/"', ": no solution"));
    await chmod(drv, 0o755);
    const r = await runLocalProof(dir);
    expect(r.status).toBe("fail");
    expect(r.checks[0]!.pass).toBe(false);
    expect(r.checks[0]!.units[0]!.reason).toMatch(/^oracle failed 'hidden-tests' on slugify/);

    // The starting repo already holds the solution: do-nothing passes, so the gate measures nothing.
    const dir2 = await freshKit("docker-solved");
    await cp(
      path.join(dir2, "proof", "oracle", "slugify", "src", "slug.js"),
      path.join(dir2, "workloads", "slugify", "input", "src", "slug.js"),
    );
    const r2 = await runLocalProof(dir2);
    expect(r2.checks[0]!.pass).toBe(true);
    expect(r2.checks[1]!.pass).toBe(false);
    expect(r2.checks[1]!.units[0]!.reason).toMatch(/^do-nothing passed every gate on slugify/);
  }, 600_000);
});
