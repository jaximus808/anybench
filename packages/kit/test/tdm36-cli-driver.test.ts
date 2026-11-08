// TDM-36 [4.4]: driver.type cli templates, the output-diff gate, the do-less variant and the
// runner stub. Everything here runs on the host with bash (3.2 on macOS is enough) and fake
// collector tools; the docker-local proof (honest passes, do-less fails, gated scoring) is
// packages/bench/test/tdm36-cli-driver-docker.test.ts.
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GateResultSchema } from "@anybench/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLI_GENERATED_MARKER,
  CLI_OUTPUT_PATHS,
  loadKit,
  parseGateResult,
  planCliStubGate,
  planCliStubTrial,
  readCliCollectorOutputs,
  renderCliDoLessDriverScript,
  renderCliDriverScript,
  renderCliGateScript,
  validateKitDir,
} from "../src/index.js";
import { tdm36ExampleFiles, TDM36_RIPGREP } from "./tdm36-cli-example-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(here, "..", "examples", "cli");
const tmpRoots: string[] = [];

async function tmpTdm36(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), `tdm36-${prefix}-`));
  tmpRoots.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(tmpRoots.map((d) => rm(d, { recursive: true, force: true })));
});

function bash(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", args, { encoding: "utf8", cwd: opts.cwd, env: opts.env });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("examples/cli is generated from the templates", () => {
  it("committed driver, do-less driver and gate equal the rendered templates", async () => {
    const files = tdm36ExampleFiles();
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(EXAMPLE, rel);
      if (process.env.TDM36_WRITE_EXAMPLE === "1") {
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content);
        await chmod(abs, 0o755);
      }
      expect(await readFile(abs, "utf8"), `${rel} drifted from its template`).toBe(content);
    }
  });

  it("the example kit validates with the do-less overlay and gated cli requirements", async () => {
    const r = await validateKitDir(EXAMPLE);
    expect(r.lines).toEqual([]);
    const spec = r.kit!.spec;
    expect(spec.proof.do_less.map((o) => [o.id, o.driver_patch ?? null, o.env ?? null])).toEqual([
      ["truncated-output", "proof/do_less/truncate/driver.sh", null],
      ["first-match-only", null, { MAX_COUNT: "1" }],
    ]);
    for (const req of spec.requirements) {
      expect(req).toMatchObject({ type: "measured", gate_id: "same-matches" });
    }
    expect(spec.requirements.map((q) => (q.type === "measured" ? q.metric : null))).toEqual([
      "wall_s",
      "peak_rss_bytes",
    ]);
  });

  it("every rendered script is valid bash", async () => {
    for (const [rel, content] of Object.entries(tdm36ExampleFiles())) {
      const f = path.join(await tmpTdm36("syntax"), path.basename(rel));
      await writeFile(f, content);
      const r = bash(["-n", f]);
      expect(r, rel).toMatchObject({ code: 0, stderr: "" });
      expect(content).toContain(CLI_GENERATED_MARKER);
    }
  });
});

describe("template options are validated", () => {
  it("rejects a gate that would pass on the exit code alone", () => {
    expect(() => renderCliGateScript({ gate_id: "g", stdout: false })).toThrow(
      /must compare stdout or at least one output file/,
    );
    expect(() => renderCliGateScript({ gate_id: "g", stdout: false, files: [] })).toThrow();
    expect(renderCliGateScript({ gate_id: "g", stdout: false, files: ["a.txt"] })).toContain(
      "files=('a.txt')",
    );
  });

  it("rejects bad ids, empty commands and escaping output files", () => {
    expect(() => renderCliDriverScript({ contender_id: "Rip Grep", command: "rg x" })).toThrow();
    expect(() => renderCliDriverScript({ contender_id: "rg", command: "   " })).toThrow();
    expect(() =>
      renderCliDriverScript({ contender_id: "rg", command: "x", exit_codes: [] }),
    ).toThrow();
    expect(() => renderCliGateScript({ gate_id: "g", files: ["../etc/passwd"] })).toThrow();
    expect(() => renderCliGateScript({ gate_id: "g", files: ["a b.txt"] })).toThrow();
    expect(() => renderCliDoLessDriverScript(TDM36_RIPGREP, { keep_lines: -1 })).toThrow();
  });

  it("the do-less driver differs from the honest one only in the header and the subject line", () => {
    const honest = renderCliDriverScript(TDM36_RIPGREP).split("\n");
    const less = renderCliDoLessDriverScript(TDM36_RIPGREP, { keep_lines: 3 }).split("\n");
    expect(less.length).toBe(honest.length);
    const changed = honest.flatMap((l, i) => (l === less[i] ? [] : [[l, less[i]]]));
    expect(changed).toHaveLength(3);
    expect(changed[2]).toEqual([
      "subject() { subject_cmd; }",
      "subject() { subject_cmd | head -n 3; }",
    ]);
  });

  it("drops the collectors that are switched off", () => {
    const s = renderCliDriverScript({ contender_id: "x", command: "true", collectors: [] });
    expect(s).not.toContain("hyperfine");
    expect(s).not.toContain("gnu_time");
    const t = renderCliDriverScript({ contender_id: "x", command: "true", exit_codes: [0, 1] });
    expect(t).toContain("--ignore-failure");
    expect(t).toContain('--export-json "$out/hyperfine.json"');
    expect(t).toContain('-o "$out/time.txt"');
  });
});

// ---------------------------------------------------------------------------------------------
// The driver on the host, with fake GNU time and hyperfine that call through to the subject.

const FAKE_TIME = `#!/usr/bin/env bash
# fake GNU time: time -v -o FILE cmd...
[ "$1" = -v ] && [ "$2" = -o ] || exit 99
f="$3"; shift 3
rc=0; "$@" || rc=$?
printf 'fake time -v report\\nExit status: %s\\n' "$rc" > "$f"
exit "$rc"
`;

const FAKE_HYPERFINE = `#!/usr/bin/env bash
# fake hyperfine: records its args, runs the command once through bash, writes a tiny export.
printf '%s\\n' "$@" > "$TDM36_HF_ARGS"
json="" cmd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --export-json) json="$2"; shift 2 ;;
    --command-name|--runs|--warmup) shift 2 ;;
    --*) shift ;;
    *) cmd="$1"; shift ;;
  esac
done
bash -c "$cmd" > /dev/null
printf '{"results":[{"command":"%s","mean":0.01,"stddev":0,"median":0.01,"user":0,"system":0,"min":0.01,"max":0.01,"times":[0.01,0.01],"exit_codes":[0,0]}]}\\n' "$cmd" > "$json"
`;

async function fakeTools(): Promise<{ env: NodeJS.ProcessEnv; hfArgs: string }> {
  const dir = await tmpTdm36("tools");
  await writeFile(path.join(dir, "time"), FAKE_TIME, { mode: 0o755 });
  await writeFile(path.join(dir, "hyperfine"), FAKE_HYPERFINE, { mode: 0o755 });
  const hfArgs = path.join(dir, "hf-args.txt");
  return {
    hfArgs,
    env: {
      PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      ANYBENCH_GNU_TIME: path.join(dir, "time"),
      TDM36_HF_ARGS: hfArgs,
    },
  };
}

const LINES_CMD = [
  "cat lines.txt",
  'printf "written\\n" > "$CLI_FILES_OUT/result.txt"',
  'exit "${FAIL_WITH:-0}"',
].join("\n");

async function runDriver(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string; out: string }> {
  const root = await tmpTdm36("driver");
  const drv = path.join(root, "driver.sh");
  await writeFile(drv, script, { mode: 0o755 });
  await mkdir(path.join(root, "in"));
  await writeFile(path.join(root, "in", "lines.txt"), "one\ntwo\nthree\n");
  const out = path.join(root, "out");
  const r = bash([drv, "run", path.join(root, "in"), out], { env });
  return { code: r.code, stderr: r.stderr, out };
}

describe("the rendered driver on the host (fake time and hyperfine)", () => {
  it("captures the gated run and both collector outputs; timed runs never touch them", async () => {
    const { env, hfArgs } = await fakeTools();
    const script = renderCliDriverScript({ contender_id: "lines", command: LINES_CMD });
    const r = await runDriver(script, env);
    expect(r).toMatchObject({ code: 0 });
    const read = (rel: string) => readFile(path.join(r.out, rel), "utf8");
    expect(await read(CLI_OUTPUT_PATHS.stdout)).toBe("one\ntwo\nthree\n");
    expect(await read(CLI_OUTPUT_PATHS.exitCode)).toBe("0\n");
    expect(await read(`${CLI_OUTPUT_PATHS.filesDir}/result.txt`)).toBe("written\n");
    expect(await read(CLI_OUTPUT_PATHS.time)).toContain("fake time -v report");
    const args = (await readFile(hfArgs, "utf8")).trim().split("\n");
    expect(args).toEqual(
      expect.arrayContaining(["--shell=bash", "--output=null", "--runs", "10", "subject"]),
    );
    const { inputs, missing } = await readCliCollectorOutputs(r.out);
    expect(missing).toEqual([]);
    expect(inputs.map((i) => i.collector)).toEqual(["time", "hyperfine"]);
    expect(JSON.parse(inputs[1]!.raw).results[0].command).toBe("subject");
  });

  it("the do-less driver truncates stdout in the gated run", async () => {
    const { env } = await fakeTools();
    const script = renderCliDoLessDriverScript({ contender_id: "lines", command: LINES_CMD });
    const r = await runDriver(script, env);
    expect(r.code).toBe(0);
    expect(await readFile(path.join(r.out, CLI_OUTPUT_PATHS.stdout), "utf8")).toBe("one\n");
  });

  it("records an unaccepted exit code, fails the verb and skips the timed runs", async () => {
    const { env, hfArgs } = await fakeTools();
    const script = renderCliDriverScript({ contender_id: "lines", command: LINES_CMD });
    const r = await runDriver(script, { ...env, FAIL_WITH: "3" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the subject exited 3 (accepted: 0 )");
    expect(await readFile(path.join(r.out, CLI_OUTPUT_PATHS.exitCode), "utf8")).toBe("3\n");
    await expect(access(hfArgs)).rejects.toThrow();
    const { missing } = await readCliCollectorOutputs(r.out);
    expect(missing).toEqual(["hyperfine"]);
  });

  it("fails loudly when GNU time is not installed", async () => {
    const { env } = await fakeTools();
    const script = renderCliDriverScript({ contender_id: "lines", command: LINES_CMD });
    const r = await runDriver(script, { ...env, ANYBENCH_GNU_TIME: "/nonexistent/time" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("GNU time not found at /nonexistent/time");
  });

  it("start, ready and stop are no-ops; unknown verbs exit 2", async () => {
    const f = path.join(await tmpTdm36("verbs"), "driver.sh");
    await writeFile(f, renderCliDriverScript({ contender_id: "x", command: "true" }));
    for (const v of ["start", "ready", "stop"]) expect(bash([f, v]).code).toBe(0);
    expect(bash([f, "launch"]).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The output-diff gate on the host, against the example's reference.

const CHECK = path.join(EXAMPLE, "gates/same-matches/check.sh");
const REFERENCE = path.join(EXAMPLE, "reference/same-matches/literal-search/stdout.txt");

async function frozen(stdout: string | null, exitCode: string | null = "0\n"): Promise<string> {
  const out = path.join(await tmpTdm36("frozen"), "out");
  await mkdir(path.join(out, "cli"), { recursive: true });
  if (stdout !== null) await writeFile(path.join(out, CLI_OUTPUT_PATHS.stdout), stdout);
  if (exitCode !== null) await writeFile(path.join(out, CLI_OUTPUT_PATHS.exitCode), exitCode);
  return out;
}

async function gate(
  out: string,
  workload = "literal-search",
  check = CHECK,
): Promise<{
  code: number;
  stderr: string;
  verdict: ReturnType<typeof parseGateResult> | null;
  diff: string | null;
  gateJson: string;
}> {
  const vdir = await tmpTdm36("verdict");
  const gateJson = path.join(vdir, "gate.json");
  const r = bash([check, out, workload, gateJson], { env: { PATH: process.env.PATH } });
  const text = await readFile(gateJson, "utf8").catch(() => null);
  const diff = await readFile(path.join(vdir, "gate.diff"), "utf8").catch(() => null);
  return {
    code: r.code,
    stderr: r.stderr,
    verdict: text === null ? null : parseGateResult(text),
    diff,
    gateJson,
  };
}

describe("the output-diff gate (check.sh as its own process)", async () => {
  const reference = await readFile(REFERENCE, "utf8");

  it("passes the reference output, in any line order (sort_lines)", async () => {
    const shuffled = reference.trimEnd().split("\n").reverse().join("\n") + "\n";
    const g = await gate(await frozen(shuffled));
    expect(g.code).toBe(0);
    expect(g.verdict).toEqual({
      pass: true,
      reason: "same-matches: exit code and stdout equal the reference for literal-search",
      evidence: ["cli/exit_code", "cli/stdout.txt"],
    });
    expect(g.diff).toBeNull();
  });

  it("fails truncated output with a clear reason and writes a diff", async () => {
    const first = reference.split("\n")[0] + "\n";
    const g = await gate(await frozen(first));
    expect(g.code).toBe(0);
    expect(g.verdict?.pass).toBe(false);
    expect(g.verdict?.reason).toBe(
      "same-matches: literal-search failed: cli/stdout.txt differs from the reference: got 1 line(s), expected 4; 3 expected line(s) missing and none extra (output truncated?)",
    );
    expect(g.verdict?.evidence).toEqual(["cli/exit_code", "cli/stdout.txt"]);
    expect(g.diff).toContain("--- reference/cli/stdout.txt");
    expect(g.diff).toContain("+++ cli/stdout.txt");
    expect(g.diff).toMatch(/^-tree\/src\/power\.c:4:PM_RESUME$/m);
  });

  it("fails wrong output, an unaccepted exit code and a missing stdout", async () => {
    const wrong = await gate(await frozen(reference.replace("power.c:4", "power.c:9")));
    expect(wrong.verdict?.reason).toContain("1 expected line(s) missing, 1 unexpected");
    const crashed = await gate(await frozen(reference, "139\n"));
    expect(crashed.verdict).toMatchObject({ pass: false });
    expect(crashed.verdict?.reason).toBe(
      "same-matches: literal-search failed: the subject exited 139 (accepted: 0 1 )",
    );
    const none = await gate(await frozen(null, null));
    expect(none.verdict?.reason).toBe(
      "same-matches: literal-search failed: cli/exit_code is missing; cli/stdout.txt is missing",
    );
  });

  it("refuses a symlinked stdout even when it points at the reference", async () => {
    const out = await frozen(null);
    await symlink(REFERENCE, path.join(out, CLI_OUTPUT_PATHS.stdout));
    const g = await gate(out);
    expect(g.verdict).toMatchObject({ pass: false });
    expect(g.verdict?.reason).toContain("cli/stdout.txt is a symlink");
  });

  it("a bad workload id or a missing reference is a kit error: exit 2, no verdict", async () => {
    const out = await frozen(reference);
    for (const w of ["../literal-search", "Literal", "no-such-workload"]) {
      const g = await gate(out, w);
      expect(g.code, w).toBe(2);
      expect(g.verdict, w).toBeNull();
    }
    const wrongArgs = bash([CHECK, out]);
    expect(wrongArgs.code).toBe(2);
  });

  it("compares declared output files byte for byte", async () => {
    const kit = await tmpTdm36("filekit");
    const check = path.join(kit, "gates/files-gate/check.sh");
    await mkdir(path.dirname(check), { recursive: true });
    await writeFile(
      check,
      renderCliGateScript({ gate_id: "files-gate", stdout: false, files: ["report/out.json"] }),
    );
    await mkdir(path.join(kit, "reference/files-gate/w1/files/report"), { recursive: true });
    await writeFile(path.join(kit, "reference/files-gate/w1/files/report/out.json"), '{"n":1}\n');
    const out = await frozen("ignored\n");
    await mkdir(path.join(out, "cli/files/report"), { recursive: true });
    await writeFile(path.join(out, "cli/files/report/out.json"), '{"n":1}\n');
    const ok = await gate(out, "w1", check);
    expect(ok.verdict).toEqual({
      pass: true,
      reason: "files-gate: exit code and 1 output file(s) equal the reference for w1",
      evidence: ["cli/exit_code", "cli/files/report/out.json"],
    });
    await writeFile(path.join(out, "cli/files/report/out.json"), '{"n":2}\n');
    const bad = await gate(out, "w1", check);
    expect(bad.verdict?.pass).toBe(false);
    expect(bad.verdict?.reason).toContain("cli/files/report/out.json differs from the reference");
    expect(GateResultSchema.safeParse(bad.verdict).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The runner stub keeps the subject computer and the scoring computer apart.

describe("runner stub plans", async () => {
  const kit = await loadKit(EXAMPLE);

  it("ships only the contender's adapter and the workload input to the subject computer", async () => {
    const p = await planCliStubTrial(kit, "ripgrep", "literal-search", { root: "/home/naive/t1" });
    expect(p.files.map((f) => f.to).sort()).toEqual([
      "in/pattern.txt",
      "in/tree/README",
      "in/tree/src/power.c",
      "kit/adapters/ripgrep/driver.sh",
      "kit/adapters/ripgrep/healthcheck.sh",
      "kit/adapters/ripgrep/install.sh",
      "run.sh",
    ]);
    expect(p.workloadSha256).toBe(kit.spec.workloads[0]!.sha256);
    expect(p.script).toContain(
      `bash -c 'adapters/ripgrep/driver.sh run '\\''/home/naive/t1/in'\\'' '\\''/home/naive/t1/out'\\''' || rc=$?`,
    );
    expect(p.script).toContain("export EVAL_IN='/home/naive/t1/in' EVAL_WS='/home/naive/t1/ws'");
    const f = path.join(await tmpTdm36("stub"), "run.sh");
    await writeFile(f, p.script);
    expect(bash(["-n", f]).code).toBe(0);
  });

  it("applies overlays: a replacement driver, or env", async () => {
    const truncated = await planCliStubTrial(kit, "ripgrep", "literal-search", {
      root: "/r",
      overlay: "truncated-output",
    });
    const drv = truncated.files.find((f) => f.to === "kit/adapters/ripgrep/driver.sh")!;
    expect(new TextDecoder().decode(drv.content)).toContain("subject_cmd | head -n 1");
    expect(drv.mode).toBe(0o755);
    const first = await planCliStubTrial(kit, "ripgrep", "literal-search", {
      root: "/r",
      overlay: "first-match-only",
      env: { ANYBENCH_GNU_TIME: "/usr/bin/time" },
    });
    expect(first.script).toContain("export MAX_COUNT='1'");
    expect(first.script).toContain("export ANYBENCH_GNU_TIME='/usr/bin/time'");
    await expect(
      planCliStubTrial(kit, "gnu-grep", "literal-search", {
        root: "/r",
        overlay: "truncated-output",
      }),
    ).rejects.toThrow(/applies to contender 'ripgrep'/);
    await expect(planCliStubTrial(kit, "ripgrep", "nope", { root: "/r" })).rejects.toThrow();
    await expect(
      planCliStubTrial(kit, "ripgrep", "literal-search", { root: "rel" }),
    ).rejects.toThrow();
  });

  // A copy of the example whose ripgrep driver (or do-less driver_patch) lives somewhere else.
  async function kitWithTdm36(edit: { driverScript?: string; driverPatch?: string }) {
    const dir = await tmpTdm36("guard-kit");
    await cp(EXAMPLE, dir, { recursive: true });
    const yamlPath = path.join(dir, "anybench.yaml");
    let y = await readFile(yamlPath, "utf8");
    const drv = await readFile(path.join(EXAMPLE, "adapters/ripgrep/driver.sh"));
    if (edit.driverScript) {
      await mkdir(path.dirname(path.join(dir, edit.driverScript)), { recursive: true });
      await writeFile(path.join(dir, edit.driverScript), drv, { mode: 0o755 });
      y = y.replace(
        "      type: cli\n      verbs:\n        run: adapters/ripgrep/driver.sh run {in} {out}",
        `      type: cli\n      script: ${edit.driverScript}\n      verbs:\n        run: ${edit.driverScript} run {in} {out}`,
      );
    }
    if (edit.driverPatch) {
      await mkdir(path.dirname(path.join(dir, edit.driverPatch)), { recursive: true });
      await writeFile(path.join(dir, edit.driverPatch), drv, { mode: 0o755 });
      y = y.replace(
        "driver_patch: proof/do_less/truncate/driver.sh",
        `driver_patch: ${edit.driverPatch}`,
      );
    }
    await writeFile(yamlPath, y);
    return loadKit(dir);
  }

  it.each(["reference/driver.sh", "gates/same-matches/driver.sh", "proof/oracle/driver.sh"])(
    "refuses a driver.script at %s: answers and gates never reach the subject computer",
    async (driverScript) => {
      const bad = await kitWithTdm36({ driverScript });
      expect(bad.contenders.find((c) => c.id === "ripgrep")?.driver).toBe(driverScript);
      await expect(
        planCliStubTrial(bad, "ripgrep", "literal-search", { root: "/r" }),
      ).rejects.toThrow(/the cli stub only ships adapters\/ripgrep\/, but driver.script is/);
    },
  );

  it.each(["reference/same-matches/driver.sh", "gates/same-matches/driver.sh"])(
    "refuses an overlay driver_patch at %s",
    async (driverPatch) => {
      const bad = await kitWithTdm36({ driverPatch });
      await expect(
        planCliStubTrial(bad, "ripgrep", "literal-search", {
          root: "/r",
          overlay: "truncated-output",
        }),
      ).rejects.toThrow(/may not come from gates\/ or reference\//);
    },
  );

  it("never ships gates/, reference/ or proof/ to the subject computer", async () => {
    for (const c of kit.contenders) {
      for (const w of kit.workloads) {
        for (const overlay of [
          undefined,
          "truncated-output",
          "first-match-only",
          "grep-reference",
        ]) {
          const p = await planCliStubTrial(kit, c.id, w.id, {
            root: "/r",
            ...(overlay ? { overlay } : {}),
          }).catch(() => null);
          for (const f of p?.files ?? []) {
            expect(f.to).toMatch(/^(kit\/adapters\/[a-z0-9-]+\/|in\/|run\.sh$)/);
            expect(new TextDecoder().decode(f.content)).not.toContain("tree/src/power.c:4:");
          }
        }
      }
    }
  });

  it("ships only the gate and its reference to the scoring computer", async () => {
    const g = await planCliStubGate(kit, "same-matches", "literal-search", { root: "/s/t1" });
    expect(g.files.map((f) => f.to).sort()).toEqual([
      "gate.sh",
      "kit/gates/same-matches/check.sh",
      "kit/reference/same-matches/literal-search/stdout.txt",
      "kit/reference/same-matches/unicode-regex/stdout.txt",
    ]);
    expect(g.script).toContain(
      "exec bash '/s/t1/kit/gates/same-matches/check.sh' \"$root/frozen\" 'literal-search' \"$root/gate/gate.json\"",
    );
  });

  it("runs end to end on the host: honest output passes, truncated fails (fake subject)", async () => {
    // A self-contained kit whose cli subject is `cat`, so no ripgrep is needed on the host.
    const dir = await tmpTdm36("e2e-kit");
    await cp(EXAMPLE, dir, { recursive: true });
    const cat = {
      contender_id: "ripgrep",
      command: "cat tree/README tree/src/power.c | grep -o PM_RESUME | sed 's/^/x:/'",
      exit_codes: [0, 1],
    };
    await writeFile(path.join(dir, "adapters/ripgrep/driver.sh"), renderCliDriverScript(cat), {
      mode: 0o755,
    });
    await writeFile(
      path.join(dir, "proof/do_less/truncate/driver.sh"),
      renderCliDoLessDriverScript(cat),
      { mode: 0o755 },
    );
    await writeFile(
      path.join(dir, "reference/same-matches/literal-search/stdout.txt"),
      "x:PM_RESUME\nx:PM_RESUME\nx:PM_RESUME\nx:PM_RESUME\n",
    );
    const local = await loadKit(dir);
    const { env } = await fakeTools();
    const verdicts: Record<string, boolean | undefined> = {};
    for (const overlay of [undefined, "truncated-output"] as const) {
      const root = await tmpTdm36("e2e-root");
      const t = await planCliStubTrial(local, "ripgrep", "literal-search", {
        root,
        ...(overlay ? { overlay } : {}),
        env: { ANYBENCH_GNU_TIME: env.ANYBENCH_GNU_TIME!, TDM36_HF_ARGS: env.TDM36_HF_ARGS! },
      });
      for (const f of t.files) {
        await mkdir(path.dirname(path.join(root, f.to)), { recursive: true });
        await writeFile(path.join(root, f.to), f.content, { mode: f.mode });
      }
      const run = bash([path.join(root, "run.sh")], { env });
      expect(run.code, run.stderr).toBe(0);
      const sroot = await tmpTdm36("e2e-score");
      const g = await planCliStubGate(local, "same-matches", "literal-search", { root: sroot });
      for (const f of g.files) {
        await mkdir(path.dirname(path.join(sroot, f.to)), { recursive: true });
        await writeFile(path.join(sroot, f.to), f.content, { mode: f.mode });
      }
      await cp(t.frozenTar, g.frozenTar);
      const check = bash([path.join(sroot, "gate.sh")], { env: { PATH: process.env.PATH } });
      expect(check.code, check.stderr).toBe(0);
      verdicts[overlay ?? "honest"] = parseGateResult(await readFile(g.gateJson, "utf8")).pass;
    }
    expect(verdicts).toEqual({ honest: true, "truncated-output": false });
  });
});
