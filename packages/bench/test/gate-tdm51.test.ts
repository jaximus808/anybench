// TDM-51 [5.6]: the gate runner on FakeProvider (no Docker, no network, no money). The scoring
// computer is scripted; these tests pin the orchestration: a fresh computer per trial, never
// forked from a subject snapshot, only gates/ + reference/ on it, the presigned URL never on a
// command line, fail-closed verdicts, and the computer destroyed on every path.
import { newId, RunIdSchema, TrialIdSchema, type Gate } from "@anybench/core";
import { createComputerRegistry, MemoryComputerStore } from "@anybench/envs";
import { FakeProvider, type FakeExecContext } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  GATE_VERDICT_MAX_BYTES,
  GateInfraError,
  GateKitError,
  gateResultsOf,
  normalizeVerdict,
  runGates,
  SCORE_ROOT,
  trialGateSummary,
  TrialGateRecordSchema,
  type GateRunInput,
} from "../src/index.js";

const enc = new TextEncoder();
const SHA = "a".repeat(64);
const URL_SECRET = "https://r2.example.com/runs/x/trials/y/out.tar.gz?X-Amz-Signature=deadbeef";

const GATES: Gate[] = [
  { id: "tests", kind: "hidden-tests", timeout_s: 1 },
  { id: "db", kind: "db-state", timeout_s: 1 },
];
const SCORING = [
  { path: "gates/tests/check.sh", data: enc.encode("#!/bin/sh\n") },
  { path: "gates/db/check.sh", data: enc.encode("#!/bin/sh\n") },
  { path: "reference/tests/w1/cases.txt", data: enc.encode("1 2 3\n") },
];

interface GateScript {
  rc?: number;
  verdict?: string | null;
  /** Never write a status file (the gate is lost). */
  lost?: boolean;
}

function setupTdm51(
  opts: {
    gates?: Record<string, GateScript>;
    setup?: { stdout?: string; exitCode?: number };
    fetchExit?: number;
  } = {},
) {
  const fake = new FakeProvider({ name: `fake-tdm51-${Math.random().toString(36).slice(2)}` });
  const store = new MemoryComputerStore();
  const registry = createComputerRegistry({
    provider: fake,
    store,
    pricing: { pricePerBlockMicroUsd: 1000n },
  });
  const runs: string[] = [];
  fake.onExec(/\.anybench\/score\/fetch\.sh'$/, () => ({
    exitCode: opts.fetchExit ?? 0,
    stderr: opts.fetchExit ? "curl: (22) 403" : "",
  }));
  fake.onExec(/\.anybench\/score\/setup\.sh'$/, () => ({
    stdout: opts.setup?.stdout ?? `AB_SETUP frozen=ok sha256=${SHA}\n`,
    exitCode: opts.setup?.exitCode ?? 0,
  }));
  fake.onExec(/bin\/gate-([a-z0-9._-]+)\.sh'/, (ctx: FakeExecContext) => {
    const id = ctx.match![1]!;
    runs.push(id);
    const g = opts.gates?.[id] ?? {
      verdict: JSON.stringify({ pass: true, reason: `${id} ok`, evidence: ["out.txt"] }),
    };
    if (g.lost) return "";
    const present = g.verdict !== null && g.verdict !== undefined;
    if (present) ctx.writeFile(`${SCORE_ROOT}/status/${id}.verdict`, g.verdict!);
    ctx.writeFile(`${SCORE_ROOT}/status/${id}.log`, `log of ${id}\n`);
    ctx.writeFile(
      `${SCORE_ROOT}/status/${id}.json`,
      JSON.stringify({ rc: g.rc ?? 0, duration_ms: 5, verdict: present ? "present" : "missing" }),
    );
    return "";
  });
  fake.onExec(/bin\/kill\.sh'/, () => "");
  fake.onExec(/^cat '([^']+)'/, (ctx: FakeExecContext) => {
    const text = ctx.readFile(ctx.match![1]!);
    return text === undefined ? { exitCode: 1 } : { stdout: text };
  });
  const input = (over: Partial<GateRunInput> = {}): GateRunInput => ({
    runId: newId(RunIdSchema),
    trialId: newId(TrialIdSchema),
    workloadId: "w1",
    gates: GATES,
    frozen: { kind: "bytes", data: enc.encode("tarball"), sha256: SHA },
    scoring: SCORING,
    ...over,
  });
  const deps = { registry, pollIntervalMs: 5, graceMs: 0, sleep: async () => undefined };
  return { fake, store, registry, runs, input, deps };
}

async function liveComputers(fake: FakeProvider) {
  return (await fake.list()).filter((c) => c.status !== "destroyed");
}

describe("runGates on a fresh scoring computer (FakeProvider)", () => {
  it("scores every gate on a fresh, tagged computer and destroys it", async () => {
    const t = setupTdm51();
    const inp = t.input();
    const rec = await runGates(inp, t.deps);
    expect(TrialGateRecordSchema.parse(rec)).toEqual(rec);
    expect(rec.gates.tests!.result).toEqual({
      pass: true,
      applicable: true,
      reason: "tests ok",
      evidence: ["out.txt"],
    });
    expect(rec.gates.tests!.status).toBe("verdict");
    expect(rec.gates.tests!.log_tail).toBe("log of tests\n");
    expect(rec.sandbox).toBe("uid");
    expect(rec.outputs_sha256).toBe(SHA);
    expect(rec.scoring_computer?.destroyed).toBe(true);
    expect(t.runs).toEqual(["tests", "db"]);
    expect(await liveComputers(t.fake)).toEqual([]);
    const row = await t.store.get(rec.scoring_computer!.computer_id);
    expect(row).toMatchObject({ status: "destroyed", runId: inp.runId, trialId: inp.trialId });
    expect(gateResultsOf(rec)).toEqual({
      tests: rec.gates.tests!.result,
      db: rec.gates.db!.result,
    });
    expect(trialGateSummary(rec)).toMatchObject({ pass: true, reason: "2/2 gates passed" });
  });

  it("puts only gates/ and reference/ on the scoring computer, and refuses anything else", async () => {
    const t = setupTdm51();
    const puts: string[] = [];
    const putFile = t.fake.putFile.bind(t.fake);
    t.fake.putFile = (id, path, content, o) => {
      puts.push(path);
      return putFile(id, path, content, o);
    };
    await runGates(t.input(), t.deps);
    const kit = puts.filter((p) => p.startsWith(".anybench/score/kit/"));
    expect(kit.sort()).toEqual(SCORING.map((f) => `.anybench/score/kit/${f.path}`).sort());
    expect(puts.filter((p) => !p.startsWith(".anybench/score/"))).toEqual([]);
    for (const bad of ["adapters/summer/driver.sh", "workloads/w1/answers.txt", "proof/oracle/x"]) {
      await expect(
        runGates(t.input({ scoring: [...SCORING, { path: bad, data: enc.encode("x") }] }), t.deps),
      ).rejects.toBeInstanceOf(GateKitError);
    }
    // Refused before any spend.
    expect((await t.fake.list({ includeDestroyed: true })).length).toBe(1);
  });

  it("refuses a kit whose check script is not in the bundle", async () => {
    const t = setupTdm51();
    await expect(
      runGates(t.input({ scoring: SCORING.filter((f) => f.path !== "gates/db/check.sh") }), t.deps),
    ).rejects.toThrow(/gates\/db\/check\.sh is not in the scoring bundle/);
    expect(await t.fake.list({ includeDestroyed: true })).toEqual([]);
  });

  it("forks the scoring snapshot, and never one that held a subject", async () => {
    const t = setupTdm51();
    const base = await t.fake.create({});
    await t.fake.waitReady(base.id);
    const snap = await t.fake.snapshot(base.id);
    await t.fake.destroy(base.id);
    const rec = await runGates(t.input({ profile: { snapshotId: snap.snapshotId } }), t.deps);
    expect(rec.scoring_computer?.snapshot_id).toBe(snap.snapshotId);
    await expect(
      runGates(
        t.input({
          profile: { snapshotId: snap.snapshotId },
          subjectSnapshotIds: [snap.snapshotId],
        }),
        t.deps,
      ),
    ).rejects.toThrow(/held a subject/);
  });

  it("missing frozen outputs fail every gate closed without starting a computer", async () => {
    const t = setupTdm51();
    const rec = await runGates(
      t.input({ frozen: { kind: "missing", reason: "out.tar.gz was never uploaded" } }),
      t.deps,
    );
    expect(rec.scoring_computer).toBeNull();
    for (const g of Object.values(rec.gates)) {
      expect(g.status).toBe("no_outputs");
      expect(g.result.pass).toBe(false);
      expect(g.result.reason).toMatch(/never uploaded.*fail closed/);
    }
    expect(await t.fake.list({ includeDestroyed: true })).toEqual([]);
  });

  it("outputs that could not be unpacked fail closed, and the computer is destroyed", async () => {
    const t = setupTdm51({ setup: { stdout: `AB_SETUP frozen=invalid sha256=${SHA}\n` } });
    const rec = await runGates(t.input(), t.deps);
    expect(Object.values(rec.gates).map((g) => g.status)).toEqual(["no_outputs", "no_outputs"]);
    expect(rec.scoring_computer?.destroyed).toBe(true);
    expect(t.runs).toEqual([]);
  });

  it("pulls by presigned URL without ever putting the URL on a command line", async () => {
    const t = setupTdm51();
    let urlFile: string | undefined;
    let urlMode: number | undefined;
    t.fake.onExec(/\.anybench\/score\/fetch\.sh'$/, (ctx) => {
      urlFile = ctx.readFile(`${ctx.home}/.anybench/score/fetch.url`);
      urlMode = t.fake.fileStat(ctx.computerId, `${ctx.home}/.anybench/score/fetch.url`)?.mode;
      return "";
    });
    await runGates(
      t.input({ frozen: { kind: "url", url: URL_SECRET, sha256: SHA, sizeBytes: 7 } }),
      t.deps,
    );
    expect(urlFile).toBe(`${URL_SECRET}\n`);
    expect(urlMode).toBe(0o600);
    const lines = t.fake.commands().map((c) => c.command);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l).not.toContain("X-Amz-Signature");
  });

  it("a failed download or setup is our fault: GateInfraError, computer destroyed", async () => {
    const a = setupTdm51({ fetchExit: 22 });
    await expect(
      runGates(
        a.input({ frozen: { kind: "url", url: URL_SECRET, sha256: SHA, sizeBytes: 7 } }),
        a.deps,
      ),
    ).rejects.toBeInstanceOf(GateInfraError);
    expect(await liveComputers(a.fake)).toEqual([]);

    const b = setupTdm51({
      setup: { stdout: "AB_SETUP_FAIL outputs sha256 mismatch\n", exitCode: 3 },
    });
    await expect(runGates(b.input(), b.deps)).rejects.toThrow(/sha256 mismatch/);
    expect(await liveComputers(b.fake)).toEqual([]);

    const c = setupTdm51();
    c.fake.failNextProvision();
    await expect(runGates(c.input(), c.deps)).rejects.toBeInstanceOf(GateInfraError);
    expect(await liveComputers(c.fake)).toEqual([]);
  });

  it("fails closed on a missing, invalid or non-zero verdict, and on a lost gate", async () => {
    const t = setupTdm51({
      gates: {
        tests: { verdict: null },
        db: { rc: 1, verdict: JSON.stringify({ pass: true, reason: "ok", evidence: [] }) },
      },
    });
    const rec = await runGates(t.input(), t.deps);
    expect(rec.gates.tests).toMatchObject({
      status: "no_verdict",
      result: { pass: false, reason: "gate tests: wrote no gate.json (fail closed)" },
    });
    expect(rec.gates.db).toMatchObject({
      status: "check_failed",
      exit_code: 1,
      result: { pass: false },
    });
    expect(rec.gates.db!.result.reason).toMatch(/exited 1.*gate\.json is ignored/);
    expect(trialGateSummary(rec).pass).toBe(false);

    const lost = setupTdm51({ gates: { tests: { lost: true } } });
    const r2 = await runGates(lost.input(), lost.deps);
    expect(r2.gates.tests).toMatchObject({ status: "timeout", timed_out: true });
    expect(r2.gates.tests!.result.pass).toBe(false);
    expect(lost.fake.commands().some((c) => /bin\/kill\.sh/.test(c.command))).toBe(true);
    expect(r2.gates.db!.result.pass).toBe(true);
  });
});

describe("normalizeVerdict (fail closed)", () => {
  const ok = { rc: 0, duration_ms: 3, verdict: "present" as const };
  const norm = (
    status: Parameters<typeof normalizeVerdict>[0]["status"],
    verdictText: string | null,
  ) => normalizeVerdict({ gateId: "g", timeoutS: 9, status, verdictText, logTail: "" });

  it("accepts a valid gate.json and defaults applicable to true", () => {
    expect(norm(ok, '{"pass":true,"reason":"r","evidence":["a.txt"]}').result).toEqual({
      pass: true,
      applicable: true,
      reason: "r",
      evidence: ["a.txt"],
    });
  });

  it("a not-applicable gate never passes", () => {
    const o = norm(ok, '{"pass":true,"applicable":false,"reason":"no db","evidence":[]}');
    expect(o.status).toBe("verdict");
    expect(o.result).toMatchObject({ pass: false, applicable: false, reason: "no db" });
  });

  it.each([
    ["not JSON", "{pass:true}", /not JSON/],
    [
      "two documents",
      '{"pass":true,"reason":"","evidence":[]}{"pass":false,"reason":"","evidence":[]}',
      /not JSON/,
    ],
    ["wrong type", '{"pass":"yes","reason":"","evidence":[]}', /invalid: pass/],
    ["unknown key", '{"pass":true,"reason":"","evidence":[],"score":100}', /invalid/],
    ["missing evidence", '{"pass":true,"reason":""}', /invalid: evidence/],
  ])("refuses %s", (_name, text, reason) => {
    const o = norm(ok, text);
    expect(o.status).toBe("invalid_verdict");
    expect(o.result.pass).toBe(false);
    expect(o.result.reason).toMatch(reason);
  });

  it.each([
    ["symlink", /is a symlink/],
    ["not_regular", /not a regular file/],
    ["hardlink", /more than one link/],
    ["bad_owner", /not owned/],
    ["too_large", new RegExp(`larger than ${GATE_VERDICT_MAX_BYTES}`)],
  ] as const)("refuses a %s verdict file", (kind, reason) => {
    const o = norm({ rc: 0, duration_ms: 1, verdict: kind }, null);
    expect(o.status).toBe("no_verdict");
    expect(o.result.pass).toBe(false);
    expect(o.result.reason).toMatch(reason);
  });

  it("a timeout is a FAIL even with a passing verdict", () => {
    for (const rc of [124, 137]) {
      const o = norm(
        { rc, duration_ms: 9000, verdict: "present" },
        '{"pass":true,"reason":"","evidence":[]}',
      );
      expect(o).toMatchObject({ status: "timeout", timed_out: true, result: { pass: false } });
    }
    expect(norm(null, null)).toMatchObject({ status: "timeout", result: { pass: false } });
  });

  it("drops evidence paths that escape the outputs", () => {
    const o = norm(
      ok,
      JSON.stringify({
        pass: false,
        reason: "r",
        evidence: ["ok.txt", "../x", "/etc/passwd", "~/k", "a/../../b", "ok.txt"],
      }),
    );
    expect(o.result.evidence).toEqual(["ok.txt"]);
  });

  it("clips very long reasons", () => {
    const o = norm(ok, JSON.stringify({ pass: false, reason: "x".repeat(10_000), evidence: [] }));
    expect(o.result.reason.length).toBeLessThanOrEqual(2000);
  });
});

describe("trialGateSummary", () => {
  it("not-applicable gates neither pass nor fail the trial; none applicable is no pass", () => {
    const base = {
      status: "verdict" as const,
      exit_code: 0,
      timed_out: false,
      duration_ms: 1,
      log_tail: "",
    };
    const rec = TrialGateRecordSchema.parse({
      version: 1,
      trial_id: "t",
      workload_id: "w",
      scored_at: new Date().toISOString(),
      scoring_computer: null,
      sandbox: "uid",
      outputs_sha256: null,
      gates: {
        a: { ...base, result: { pass: true, applicable: true, reason: "ok", evidence: ["e"] } },
        b: { ...base, result: { pass: false, applicable: false, reason: "n/a", evidence: [] } },
      },
    });
    expect(trialGateSummary(rec)).toEqual({
      pass: true,
      applicable: true,
      reason: "1/1 gates passed",
      evidence: ["e"],
    });
    const none = { ...rec, gates: { b: rec.gates.b! } };
    expect(trialGateSummary(none)).toMatchObject({ pass: false, applicable: false });
  });
});
