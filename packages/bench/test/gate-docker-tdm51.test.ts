// TDM-51 [5.6] done condition, on docker-local: an honest contender passes, and every cheater
// fails with a reason. Each trial is scored on its own fresh scoring container (the registry gives
// it a computers row and a trial tag); the container is destroyed afterwards. Skips cleanly when
// no Docker daemon answers.
//
// The kit is test/fixtures/gate-kit-tdm51: gates sum-tests (hidden cases run against the
// contender's workspace/sum.sh through $AB_RUN), db-state (does not apply to `add`), clean-room
// (asserts the sandbox from inside a check). It also carries adapters/ and proof/ so the test can
// show they never reach the scoring computer.
//
// Set ANYBENCH_GATE_LOG=<file> to write each trial's outcomes as JSON (docs/findings/gate-runner.md).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, RunIdSchema, TrialIdSchema, type Gate } from "@anybench/core";
import { createComputerRegistry, MemoryComputerStore } from "@anybench/envs";
import { DockerLocalProvider, dockerLocalAvailable } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectScoringFiles,
  runGates,
  trialGateSummary,
  type FrozenOutputs,
  type ScoringFile,
  type TrialGateRecord,
} from "../src/index.js";

const available = await dockerLocalAvailable();
const KIT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gate-kit-tdm51");
const NS_LABEL = "anybench.test-tdm51";
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const GATES: Gate[] = [
  { id: "sum-tests", kind: "hidden-tests", timeout_s: 8 },
  { id: "db-state", kind: "db-state", timeout_s: 30 },
  { id: "clean-room", kind: "custom", timeout_s: 30 },
];

const HONEST = "echo $(( $1 + $2 ))\n";
const WRONG = "echo $(( $1 + $2 + 1 ))\n";

/** Contender outputs as they would be frozen by the runner (the `out/` tree). */
const CONTENDERS: Record<string, (dir: string) => Promise<void>> = {
  honest: async (d) => {
    await put(d, "workspace/sum.sh", HONEST);
  },
  // do-less: off by one on every case.
  "do-less": async (d) => {
    await put(d, "workspace/sum.sh", WRONG);
  },
  // Ships its own "pass" gate.json in the outputs.
  "forged-verdict": async (d) => {
    await put(d, "workspace/sum.sh", WRONG);
    const forged = '{"pass":true,"reason":"trust me","evidence":[]}\n';
    await put(d, "gate.json", forged);
    await put(d, "workspace/gate.json", forged);
  },
  // Rewrites the hidden cases to match its wrong answers before answering.
  "tamper-tests": async (d) => {
    await put(
      d,
      "workspace/sum.sh",
      'for f in /var/lib/anybench-score/kit/reference/sum-tests/*/cases.txt; do printf "1 1 0\\n" > "$f" 2>/dev/null; done\necho 0\n',
    );
  },
  // Looks its answer up in the hidden cases.
  "peek-reference": async (d) => {
    await put(
      d,
      "workspace/sum.sh",
      'awk -v a="$1" -v b="$2" \'$1==a && $2==b {print $3}\' /var/lib/anybench-score/kit/reference/sum-tests/add/cases.txt\n',
    );
  },
  // The reviewer's race: on the first call, a setsid loop rewrites the verdict to pass forever.
  "race-writer": async (d) => {
    await put(
      d,
      "workspace/race.sh",
      [
        "while true; do",
        "  for f in /var/lib/anybench-score/verdict/*/gate.json; do",
        `    printf '{"pass":true,"reason":"forged","evidence":[]}' > "$f" 2>/dev/null`,
        "  done",
        "done",
        "",
      ].join("\n"),
    );
    await put(
      d,
      "workspace/sum.sh",
      "if [ ! -e .started ]; then : > .started; (setsid bash ./race.sh >/dev/null 2>&1 &); fi\necho 0\n",
    );
  },
  // SIGSTOPs the check, rewrites its verdict, SIGCONTs it.
  sigstop: async (d) => {
    await put(
      d,
      "workspace/sum.sh",
      [
        "for p in /proc/[0-9]*; do",
        '  [ "$(stat -c %U "$p" 2>/dev/null)" = abgate ] || continue',
        '  kill -STOP "${p#/proc/}" 2>/dev/null',
        `  printf '{"pass":true,"reason":"forged","evidence":[]}' > /var/lib/anybench-score/verdict/sum-tests/gate.json 2>/dev/null`,
        '  kill -CONT "${p#/proc/}" 2>/dev/null',
        "done",
        "echo $(( $1 + $2 + 1 ))",
        "",
      ].join("\n"),
    );
  },
  // Leaves a daemon that forges every verdict after the check has finished.
  "late-writer": async (d) => {
    await put(
      d,
      "workspace/forge.sh",
      [
        "sleep 3",
        "for f in /var/lib/anybench-score/verdict/*/gate.json; do",
        `  printf '{"pass":true,"reason":"forged","evidence":[]}' > "$f"`,
        "done",
        "",
      ].join("\n"),
    );
    await put(d, "workspace/sum.sh", "(setsid bash ./forge.sh >/dev/null 2>&1 &)\necho 0\n");
  },
  // Points its answer at a file outside the outputs (dropped on unpack).
  "symlink-escape": async (d) => {
    await mkdir(join(d, "workspace"), { recursive: true });
    await symlink(
      "/var/lib/anybench-score/kit/gates/sum-tests/check.sh",
      join(d, "workspace/sum.sh"),
    );
  },
  // Never answers: the gate's timeout_s ends it.
  hang: async (d) => {
    await put(d, "workspace/sum.sh", "sleep 600\n");
  },
};

async function put(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content);
}

async function bundle(root: string, name: string): Promise<FrozenOutputs> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await CONTENDERS[name]!(dir);
  const file = join(root, `${name}.tar.gz`);
  const r = spawnSync("tar", ["--format=ustar", "-czf", file, "-C", dir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
  const data = new Uint8Array(await readFile(file));
  return { kind: "bytes", data, sha256: createHash("sha256").update(data).digest("hex") };
}

describe.skipIf(!available)("gate runner on docker-local (honest vs cheaters)", () => {
  const provider = new DockerLocalProvider({ labels: { [NS_LABEL]: ns } });
  const store = new MemoryComputerStore();
  const registry = createComputerRegistry({
    provider,
    store,
    pricing: { pricePerBlockMicroUsd: 0n },
  });
  const runId = newId(RunIdSchema);
  let root = "";
  let scoring: ScoringFile[] = [];
  const results = new Map<string, TrialGateRecord>();

  async function score(name: string, frozen: FrozenOutputs): Promise<TrialGateRecord> {
    const rec = await runGates(
      {
        runId,
        trialId: newId(TrialIdSchema),
        workloadId: "add",
        gates: GATES,
        frozen,
        scoring,
      },
      { registry, pollIntervalMs: 250, graceMs: 30_000, readyTimeoutMs: 600_000 },
    );
    results.set(name, rec);
    return rec;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tdm51-"));
    scoring = await collectScoringFiles(KIT, GATES);
    const frozen = Object.fromEntries(
      await Promise.all(Object.keys(CONTENDERS).map(async (n) => [n, await bundle(root, n)])),
    ) as Record<string, FrozenOutputs>;
    frozen.corrupt = { kind: "bytes", data: new TextEncoder().encode("not a tarball\n") };
    // Score in parallel, a few containers at a time (shared, loaded machine).
    const names = Object.keys(frozen);
    for (let i = 0; i < names.length; i += 3) {
      await Promise.all(names.slice(i, i + 3).map((n) => score(n, frozen[n]!)));
    }
  }, 900_000);

  afterAll(async () => {
    const log = process.env.ANYBENCH_GATE_LOG;
    if (log) {
      const rows = [...results].map(([name, r]) => ({
        contender: name,
        sandbox: r.sandbox,
        destroyed: r.scoring_computer?.destroyed ?? null,
        gates: Object.fromEntries(
          Object.entries(r.gates).map(([id, o]) => [
            id,
            {
              status: o.status,
              pass: o.result.pass,
              applicable: o.result.applicable,
              reason: o.result.reason,
              ms: o.duration_ms,
            },
          ]),
        ),
      }));
      await appendFile(log, `${JSON.stringify({ at: new Date().toISOString(), rows })}\n`);
    }
    if (root) await rm(root, { recursive: true, force: true });
    await provider.dispose();
    const left = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=${NS_LABEL}=${ns}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (left) spawnSync("docker", ["rm", "-f", "-v", ...left.split("\n")]);
    expect(left, "the suite leaked containers").toBe("");
  }, 120_000);

  it("the scoring bundle holds gates/, reference/ and workloads/, never adapters/ or proof/", () => {
    const tops = new Set(scoring.map((f) => f.path.split("/")[0]));
    expect([...tops].sort()).toEqual(["gates", "reference", "workloads"]);
  });

  it("the honest contender passes every applicable gate, in a clean room", () => {
    const r = results.get("honest")!;
    expect(r.sandbox).toBe("uid-split");
    expect(r.scoring_computer?.destroyed).toBe(true);
    expect(r.gates["sum-tests"]!.result).toMatchObject({
      pass: true,
      applicable: true,
      reason: "3/3 hidden cases pass",
    });
    expect(r.gates["clean-room"]!.result).toMatchObject({ pass: true, reason: "clean room" });
    expect(trialGateSummary(r)).toMatchObject({ pass: true, applicable: true });
  });

  it("a gate that does not apply is recorded as not applicable, never as a pass", () => {
    const r = results.get("honest")!;
    expect(r.gates["db-state"]!.result).toMatchObject({
      pass: false,
      applicable: false,
      reason: "workload add has no database",
    });
    expect(r.gates["db-state"]!.status).toBe("verdict");
  });

  it.each([
    ["do-less", "verdict", /3\/3 hidden cases fail/],
    ["forged-verdict", "verdict", /3\/3 hidden cases fail/],
    ["tamper-tests", "verdict", /2\/3 hidden cases fail/],
    ["peek-reference", "verdict", /3\/3 hidden cases fail/],
    ["late-writer", "lingering", /contender process\(es\) still running/],
    ["race-writer", "lingering", /contender process\(es\) still running/],
    ["sigstop", "verdict", /3\/3 hidden cases fail/],
    ["symlink-escape", "verdict", /workspace\/sum\.sh is missing/],
    ["hang", "timeout", /timed out after 8s/],
    ["corrupt", "no_outputs", /could not be unpacked/],
  ])("cheater %s fails sum-tests with a reason", (name, status, reason) => {
    const r = results.get(name)!;
    const g = r.gates["sum-tests"]!;
    expect(g.result.pass).toBe(false);
    expect(g.status).toBe(status);
    expect(g.result.reason).toMatch(reason);
    expect(g.result.reason).not.toMatch(/forged/);
    expect(g.kit_fault).toBe(false);
    expect(trialGateSummary(r).pass).toBe(false);
    expect(r.scoring_computer === null || r.scoring_computer.destroyed).toBe(true);
  });

  it("cheaters that ran code still could not break the clean room", () => {
    for (const name of [
      "tamper-tests",
      "peek-reference",
      "late-writer",
      "race-writer",
      "sigstop",
      "forged-verdict",
    ]) {
      expect(results.get(name)!.gates["clean-room"]!.result, name).toMatchObject({ pass: true });
    }
  });

  it("every scoring computer has a registry row and was destroyed", async () => {
    for (const r of results.values()) {
      if (!r.scoring_computer) continue;
      const row = await store.get(r.scoring_computer.computer_id);
      expect(row?.status).toBe("destroyed");
      expect(row?.runId).toBe(runId);
    }
  });
});
