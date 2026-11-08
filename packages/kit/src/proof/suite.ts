// TDM-44 [4.12]: the six proof checks (plan.md P2, 17.2 rule 9). A generated kit runs only if it
// passes all six; a failing one goes back to the kit designer (max 2 repairs, then needs_human).
//
//   no_secret_in_kit         every kit file: core redact patterns + kit-only shapes + the worker's
//                            exact secret values. Runs FIRST; a kit holding a secret never reaches
//                            a computer, and the other five are "not run".
//   oracle_passes            the oracle overlay passes every gate it covers on every workload, and
//                            the gate gives the same verdict 3 times on the same frozen output.
//                            Before that, a gate marked `capture: {from: oracle}` whose reference
//                            for a workload is absent gets it CAPTURED from the oracle's output on
//                            the real image (reference/ only); the oracle then re-runs on a fresh
//                            computer and must pass, and a different baseline must agree.
//   do_less_fails            every do-less overlay fails some gate on some workload, a kit whose
//                            only do-less is a no-op fails (too weak to show discrimination), and
//                            for hidden-tests gates the oracle's mutants are killed (≥90%,
//                            survivors listed).
//   smoke_passes             each subject contender, un-overlaid, on the first workload on the
//                            kit's real profile: the runner finishes, every gate returns a real
//                            verdict (and passes, for deterministic drivers), every measured metric
//                            of that workload is collected.
//   regression_scores_lower  the planted regression, n times, against the honest contender n
//                            times on the first workload: it fails the gate more often, or on some
//                            measured requirement its median is worse than every honest sample.
//   baselines_in_range       every baseline contender passes every gate on every workload with
//                            every measured metric present and finite (a known-good baseline that
//                            fails the gate means the gate or its reference is wrong).
//
// Rule 4 (plan 17.2 rule 6, the founder's review): the repair loop reads these results, so no
// reason or evidence ever carries a contender metric value, and an un-overlaid contender's gate
// reason is withheld too (it can carry a score, e.g. "5/7 hidden tests pass"). Proof overlays'
// gate reasons (oracle, do-less, mutants) are evidence. Reasons are check-level:
// "do-less passed the gate: 'truncated-output' passed same-matches on literal-search".
//
// Cost and time are bounded: at most `concurrency` computers at once (each trial and each gate
// run is its own fresh computer, destroyed by the runner), a wall-time deadline after which no
// new unit starts, identical runs deduplicated (an oracle overlay with no patch and no env IS
// its contender's plain run), and do-less runs stop at the first workload that fails.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_GATE_CAPTURE_FILES,
  GATE_PASS_RATE_METRIC_NAME,
  PROOF_CHECKS,
  isAgentDriver,
  type Gate,
  type KitSpec,
  type ProofCheckResult,
  type ProofOverlay,
} from "@anybench/core";
import { KIT_LAYOUT, normalizeKitPath } from "../layout.js";
import type { LoadedKit } from "../validate.js";
import { readBundle, writeBundle } from "./bundle.js";
import { mutateOracle, isMutableSource, type Mutant } from "./mutate.js";
import {
  ProofInfraError,
  type ProofGateOutcome,
  type ProofMetric,
  type ProofRunner,
  type ProofTrialOutcome,
  type ProofTrialRequest,
} from "./port.js";
import { scanKitForSecrets } from "./secrets.js";

export const DEFAULT_PROOF_CONCURRENCY = 4;
export const DEFAULT_PROOF_DEADLINE_MS = 45 * 60_000;
export const DEFAULT_REGRESSION_REPEATS = 3;
/** The gate must give the same verdict this many times on one frozen output (17.2 rule 9). */
export const DEFAULT_GATE_REPEATS = 3;
export const DEFAULT_MUTATION_TARGET = 0.9;
export const DEFAULT_MAX_MUTANTS = 12;
/** Gate reasons quoted as evidence are cut to this. */
const EVIDENCE_REASON_MAX = 300;

/** The do-less reason the done condition names. */
export const DO_LESS_PASSED = "do-less passed the gate";
export const NO_SECRET_REASON_PREFIX = "secret in kit";

export interface ProofSuiteDeps {
  runner: ProofRunner;
  /** The worker's configured secret values (exact match). Never logged or returned. */
  secretValues?: readonly string[];
  /** Computers at once (each trial / gate run is one). Default 4. */
  concurrency?: number;
  /** No new unit starts after this. Default 45 min. */
  deadlineMs?: number;
  /** Planted regression samples (and honest samples). Default 3. */
  regressionRepeats?: number;
  /** Verdict repeats on one frozen output. Default 3. */
  gateRepeats?: number;
  mutation?: { max?: number; target?: number };
  signal?: AbortSignal;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface ProofSuiteReport {
  checks: ProofCheckResult[];
  /** Kit-relative paths written by reference capture (kept only when the capture was proven). */
  captured: string[];
  /** Units that could not run for OUR reasons (infra, deadline, abort): the kit is not at fault. */
  infra: string[];
  mutation: { total: number; killed: number; survivors: string[] } | null;
  trials: number;
  gateRuns: number;
}

// ---------------------------------------------------------------------------------------------
// helpers

type Verdicts = ProofGateOutcome["gates"];

interface TrialRun {
  req: ProofTrialRequest;
  outcome: ProofTrialOutcome | null;
  /** Set when the unit did not run for our reasons. */
  infra: string | null;
}

interface GatedRun extends TrialRun {
  verdicts: Verdicts | null;
}

class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function quote(reason: string): string {
  const r = reason.replace(/\s+/g, " ").trim();
  return r.length > EVIDENCE_REASON_MAX ? `${r.slice(0, EVIDENCE_REASON_MAX - 1)}…` : r;
}

/** Every applicable gate passed (and at least one applied). */
function allPass(v: Verdicts | null, gateIds: readonly string[]): boolean {
  if (!v) return false;
  const applicable = gateIds.filter((g) => v[g]?.applicable !== false);
  return applicable.length > 0 && applicable.every((g) => v[g]?.pass === true);
}

function failedGates(v: Verdicts | null, gateIds: readonly string[]): string[] {
  if (!v) return [...gateIds];
  return gateIds.filter((g) => v[g]?.applicable !== false && v[g]?.pass !== true);
}

function verdictKey(v: Verdicts | null, gateIds: readonly string[]): string {
  if (!v) return "none";
  return gateIds
    .map((g) => `${g}:${v[g]?.applicable === false ? "na" : v[g]?.pass ? "pass" : "fail"}`)
    .join(",");
}

const isNoOpId = (id: string) => /(^|-)(no-?op|noop|do-?nothing|nothing|empty)(-|$)/.test(id);

/** The do-less overlay's kind, declared or inferred. */
export function doLessKind(o: ProofOverlay): "noop" | "partial-oracle" | "cheat" {
  return o.kind ?? (isNoOpId(o.id) ? "noop" : "cheat");
}

/** An overlay that changes nothing (no driver patch, no env): its run IS the contender's plain run. */
function neutral(o: ProofOverlay | null): boolean {
  return !o || (o.driver_patch === undefined && Object.keys(o.env ?? {}).length === 0);
}

function contenderOf(spec: KitSpec, o: ProofOverlay): string {
  return o.contender ?? spec.contenders.find((c) => c.role === "subject")!.id;
}

function measuredOn(spec: KitSpec, workloadId: string) {
  return spec.requirements.flatMap((r) =>
    r.type === "measured" && (!r.workloads || r.workloads.includes(workloadId)) ? [r] : [],
  );
}

/** Measured requirements whose metric a trial's collectors must produce (not the gate's own tally). */
function collectedOn(spec: KitSpec, workloadId: string) {
  return measuredOn(spec, workloadId).filter((r) => r.metric !== GATE_PASS_RATE_METRIC_NAME);
}

function trialValues(metrics: readonly ProofMetric[], name: string): number[] {
  return metrics
    .filter((m) => m.name === name && (m.level === undefined || m.level === "trial"))
    .map((m) => m.value)
    .filter((v) => Number.isFinite(v));
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Driver types whose output is deterministic: their smoke run must also PASS the gate. */
const DETERMINISTIC = (spec: KitSpec, contenderId: string): boolean => {
  const c = spec.contenders.find((x) => x.id === contenderId);
  return c !== undefined && !isAgentDriver(c.driver);
};

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, child)));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/** The reference dir of a gate, kit-relative, refusing anything that is not scoring-only. */
export function captureDir(gate: Gate, workloadId: string): string {
  const ref = normalizeKitPath(gate.reference ?? `${KIT_LAYOUT.gateDir(gate.id)}/reference`);
  const scoringOnly =
    ref === KIT_LAYOUT.referenceDir ||
    ref.startsWith(`${KIT_LAYOUT.referenceDir}/`) ||
    ref.startsWith(`${KIT_LAYOUT.gateDir(gate.id)}/`);
  if (!scoringOnly || ref.split("/").includes("..")) {
    throw new Error(
      `gate '${gate.id}': a captured reference must live under reference/ or gates/${gate.id}/, not ${ref}`,
    );
  }
  return `${ref}/${workloadId}`;
}

// ---------------------------------------------------------------------------------------------
// the suite

/** Run the six proof checks on a loaded kit. */
export async function runProofSuite(
  kit: LoadedKit,
  deps: ProofSuiteDeps,
): Promise<ProofCheckResult[]> {
  return (await runProofSuiteReport(kit, deps)).checks;
}

export async function runProofSuiteReport(
  kit: LoadedKit,
  deps: ProofSuiteDeps,
): Promise<ProofSuiteReport> {
  const spec = kit.spec;
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const deadline = started + (deps.deadlineMs ?? DEFAULT_PROOF_DEADLINE_MS);
  const limiter = new Limiter(Math.max(1, deps.concurrency ?? DEFAULT_PROOF_CONCURRENCY));
  const repeats = Math.max(1, deps.regressionRepeats ?? DEFAULT_REGRESSION_REPEATS);
  const gateRepeats = Math.max(1, deps.gateRepeats ?? DEFAULT_GATE_REPEATS);
  const results = new Map<(typeof PROOF_CHECKS)[number], ProofCheckResult>();
  const infra: string[] = [];
  let trials = 0;
  let gateRuns = 0;
  const set = (
    check: (typeof PROOF_CHECKS)[number],
    pass: boolean,
    reason: string,
    evidence: string[] = [],
  ) => results.set(check, { check, pass, reason, evidence });
  const finish = (
    captured: string[],
    mutation: ProofSuiteReport["mutation"],
  ): ProofSuiteReport => ({
    checks: PROOF_CHECKS.map(
      (c) =>
        results.get(c) ?? {
          check: c,
          pass: false,
          reason: "not run",
          evidence: [],
        },
    ),
    captured,
    infra,
    mutation,
    trials,
    gateRuns,
  });

  // ---- 1. no secret in the kit (before anything leaves this machine)
  const scan = await scanKitForSecrets(kit.dir, { exactValues: deps.secretValues ?? [] });
  if (scan.findings.length > 0) {
    const where = scan.findings.map((f) => `${f.kind} in ${f.file}:${f.line}`);
    set(
      "no_secret_in_kit",
      false,
      `${NO_SECRET_REASON_PREFIX}: ${where.slice(0, 5).join("; ")}`,
      where,
    );
    for (const c of PROOF_CHECKS) {
      if (c !== "no_secret_in_kit") {
        set(c, false, "not run: the kit holds a secret, so nothing was sent to a computer");
      }
    }
    return finish([], null);
  }
  set(
    "no_secret_in_kit",
    true,
    `no secret in ${scan.filesScanned} kit file(s) (key patterns and the worker's exact secret values)`,
    scan.truncated.map((f) => `only the head of ${f} was scanned (large file)`),
  );

  // ---- units
  const gateIds = spec.gates.map((g) => g.id);
  const oracle = spec.proof.oracle;
  const oracleGates = oracle?.gates ?? gateIds;
  const workloads = spec.workloads.map((w) => w.id);
  const first = workloads[0]!;
  const stopped = (): string | null => {
    if (deps.signal?.aborted) return "aborted";
    if (now() > deadline) return "proof wall time exceeded";
    return null;
  };

  const trialCache = new Map<string, Promise<TrialRun>>();
  const trialKey = (req: ProofTrialRequest, fresh: string | null) =>
    JSON.stringify([
      req.contenderId,
      req.workloadId,
      neutral(req.overlay) ? null : [req.overlay!.driver_patch ?? null, req.overlay!.env ?? {}],
      fresh,
    ]);

  const runTrial = (req: ProofTrialRequest, fresh: string | null = null): Promise<TrialRun> => {
    const key = trialKey(req, fresh);
    const hit = trialCache.get(key);
    if (hit) return hit;
    const p = limiter.run(async (): Promise<TrialRun> => {
      const why = stopped();
      if (why) return { req, outcome: null, infra: why };
      trials++;
      log("proof: trial", { label: req.label });
      try {
        const outcome = await deps.runner.runTrial(req, deps.signal);
        if (outcome.status === "infra_failed") {
          return { req, outcome, infra: `${req.label}: ${outcome.detail}` };
        }
        return { req, outcome, infra: null };
      } catch (err) {
        if (err instanceof ProofInfraError || deps.signal?.aborted) {
          return { req, outcome: null, infra: `${req.label}: ${errText(err)}` };
        }
        throw err;
      }
    });
    trialCache.set(key, p);
    return p;
  };

  const runGates = async (
    label: string,
    workloadId: string,
    ids: readonly string[],
    bundle: Uint8Array | null,
  ): Promise<{ verdicts: Verdicts | null; infra: string | null }> =>
    limiter.run(async () => {
      const why = stopped();
      if (why) return { verdicts: null, infra: why };
      gateRuns++;
      try {
        const out = await deps.runner.runGates(
          { label, workloadId, gateIds: ids, bundle },
          deps.signal,
        );
        return { verdicts: out.gates, infra: null };
      } catch (err) {
        if (err instanceof ProofInfraError || deps.signal?.aborted) {
          return { verdicts: null, infra: `${label}: ${errText(err)}` };
        }
        throw err;
      }
    });

  const gatedCache = new Map<string, Promise<GatedRun>>();
  const gated = (
    req: ProofTrialRequest,
    ids: readonly string[],
    fresh: string | null = null,
  ): Promise<GatedRun> => {
    const key = `${trialKey(req, fresh)}|${[...ids].sort().join(",")}`;
    const hit = gatedCache.get(key);
    if (hit) return hit.then((r) => ({ ...r, req }));
    const p = gatedOnce(req, ids, fresh);
    gatedCache.set(key, p);
    return p;
  };
  const gatedOnce = async (
    req: ProofTrialRequest,
    ids: readonly string[],
    fresh: string | null,
  ): Promise<GatedRun> => {
    const t = await runTrial(req, fresh);
    if (t.infra) {
      infra.push(t.infra);
      return { ...t, verdicts: null };
    }
    const g = await runGates(`${req.label}.gate`, req.workloadId, ids, t.outcome!.bundle);
    if (g.infra) infra.push(g.infra);
    return { ...t, infra: g.infra, verdicts: g.verdicts };
  };

  const plain = (contenderId: string, workloadId: string, tag: string): ProofTrialRequest => ({
    label: `${tag}.${contenderId}.${workloadId}`,
    contenderId,
    workloadId,
    overlay: null,
  });
  const overlaid = (o: ProofOverlay, workloadId: string, tag: string): ProofTrialRequest => ({
    label: `${tag}.${o.id}.${workloadId}`,
    contenderId: contenderOf(spec, o),
    workloadId,
    overlay: o,
  });

  // ---- 2. reference capture (before the oracle check reads the references)
  const captured: string[] = [];
  const captureNotes: string[] = [];
  let captureFailure: string | null = null;
  const captureWorkloads = new Map<string, string[]>(); // workload → gate ids captured
  if (oracle) {
    for (const g of spec.gates) {
      if (!g.capture) continue;
      for (const w of workloads) {
        let dir: string;
        try {
          dir = captureDir(g, w);
        } catch (err) {
          captureFailure = errText(err);
          continue;
        }
        if (existsSync(path.join(kit.dir, dir))) continue;
        captureWorkloads.set(w, [...(captureWorkloads.get(w) ?? []), g.id]);
      }
    }
    await Promise.all(
      [...captureWorkloads].map(async ([w, ids]) => {
        const t = await runTrial(overlaid(oracle, w, "capture"), "capture");
        if (t.infra) {
          infra.push(t.infra);
          return;
        }
        const files = t.outcome!.bundle ? readBundle(t.outcome!.bundle) : new Map();
        for (const gid of ids) {
          const g = spec.gates.find((x) => x.id === gid)!;
          const dir = captureDir(g, w);
          for (const f of g.capture!.files ?? DEFAULT_GATE_CAPTURE_FILES) {
            const data = files.get(normalizeKitPath(f.from));
            if (!data) {
              captureFailure ??= `oracle '${oracle.id}' left no ${f.from} on ${w} to capture for gate ${gid}`;
              continue;
            }
            const rel = `${dir}/${normalizeKitPath(f.to)}`;
            if (rel.startsWith(`${KIT_LAYOUT.workloadsDir}/`)) {
              throw new Error(`refusing to write a reference under workloads/: ${rel}`);
            }
            await mkdir(path.dirname(path.join(kit.dir, rel)), { recursive: true });
            await writeFile(path.join(kit.dir, rel), data);
            captured.push(rel);
          }
        }
        captureNotes.push(
          `captured ${ids.join(", ")} reference for ${w} from oracle '${oracle.id}'`,
        );
      }),
    );
  }

  // ---- 3. the runs, all at once under the limiter
  const subjects = spec.contenders.filter((c) => c.role === "subject").map((c) => c.id);
  const baselines = spec.contenders.filter((c) => c.role === "baseline").map((c) => c.id);

  const oracleRuns = oracle
    ? Promise.all(
        workloads.map((w) =>
          gated(
            overlaid(oracle, w, "oracle"),
            oracleGates,
            captureWorkloads.has(w) ? "verify" : null,
          ),
        ),
      )
    : Promise.resolve([] as GatedRun[]);

  const baselineRuns = Promise.all(
    baselines.flatMap((b) => workloads.map((w) => gated(plain(b, w, "baseline"), gateIds))),
  );
  // An oracle overlay with no patch and no env on a baseline IS that baseline's plain run: the
  // cache key ignores the label, so the two share one trial.

  const smokeRuns = Promise.all(subjects.map((s) => gated(plain(s, first, "smoke"), gateIds)));

  const doLessRuns = Promise.all(
    spec.proof.do_less.map(async (o) => {
      const runs: GatedRun[] = [];
      for (const w of workloads) {
        const r = await gated(overlaid(o, w, "do-less"), gateIds);
        runs.push(r);
        if (r.infra || !allPass(r.verdicts, gateIds)) break; // killed (or not run): stop
      }
      return { overlay: o, runs };
    }),
  );

  const regression = spec.proof.regression;
  const regressionRuns = regression
    ? (async () => {
        const honestId = contenderOf(spec, regression);
        const honest: Promise<GatedRun>[] = [];
        const planted: Promise<GatedRun>[] = [];
        for (let i = 0; i < repeats; i++) {
          // sample 0 of the honest side is the smoke run when the regression's contender is a subject
          honest.push(
            gated(
              plain(honestId, first, i === 0 ? "smoke" : `honest${i}`),
              gateIds,
              i === 0 ? null : `n${i}`,
            ),
          );
          planted.push(gated(overlaid(regression, first, `regression${i}`), gateIds, `n${i}`));
        }
        return { honest: await Promise.all(honest), planted: await Promise.all(planted) };
      })()
    : Promise.resolve(null);

  const [oracleRes, baselineRes, smokeRes, doLessRes, regressionRes] = await Promise.all([
    oracleRuns,
    baselineRuns,
    smokeRuns,
    doLessRuns,
    regressionRuns,
  ]);

  // ---- 4. determinism + mutation (gate-only runs on the oracle's frozen outputs)
  const determinismWorkloads = captureWorkloads.size > 0 ? [...captureWorkloads.keys()] : [first];
  const determinism = await Promise.all(
    oracleRes
      .filter(
        (r) => determinismWorkloads.includes(r.req.workloadId) && r.verdicts && r.outcome?.bundle,
      )
      .map(async (r) => {
        const keys = [verdictKey(r.verdicts, oracleGates)];
        for (let i = 1; i < gateRepeats; i++) {
          const g = await runGates(
            `${r.req.label}.repeat${i}`,
            r.req.workloadId,
            oracleGates,
            r.outcome!.bundle,
          );
          if (g.infra) {
            infra.push(g.infra);
            return { workload: r.req.workloadId, same: null as boolean | null, n: i };
          }
          keys.push(verdictKey(g.verdicts, oracleGates));
        }
        return {
          workload: r.req.workloadId,
          same: keys.every((k) => k === keys[0]),
          n: keys.length,
        };
      }),
  );

  const hiddenGates = spec.gates
    .filter((g) => g.kind === "hidden-tests" && oracleGates.includes(g.id))
    .map((g) => g.id);
  let mutation: ProofSuiteReport["mutation"] = null;
  if (oracle && hiddenGates.length > 0) {
    mutation = await mutationRun(kit, oracle, hiddenGates, oracleRes, deps, runGates, infra);
  }

  // ---- 5. verdicts
  // oracle_passes
  if (!oracle) {
    set("oracle_passes", false, "the kit has no proof.oracle");
  } else if (captureFailure) {
    set("oracle_passes", false, `reference capture failed: ${captureFailure}`, captureNotes);
  } else {
    const ran = oracleRes.filter((r) => !r.infra);
    const bad = ran.filter((r) => !allPass(r.verdicts, oracleGates));
    const evidence = [
      ...captureNotes,
      ...oracleRes.map((r) =>
        r.infra
          ? `oracle on ${r.req.workloadId}: not run (${r.infra})`
          : `oracle on ${r.req.workloadId}: ${oracleGates
              .map(
                (g) =>
                  `${g} ${r.verdicts?.[g]?.pass ? "pass" : "fail"}: ${quote(r.verdicts?.[g]?.reason ?? "no verdict")}`,
              )
              .join("; ")}`,
      ),
      ...determinism.map((d) =>
        d.same === null
          ? `gate repeat on ${d.workload}: not run`
          : `gate verdict on ${d.workload}: ${d.same ? `identical ${d.n}/${d.n}` : "differed between runs"}`,
      ),
    ];
    const notRun = oracleRes.length - ran.length;
    const flaky = determinism.filter((d) => d.same === false);
    if (bad.length > 0) {
      const r = bad[0]!;
      set(
        "oracle_passes",
        false,
        `oracle '${oracle.id}' failed gate ${failedGates(r.verdicts, oracleGates).join(", ")} on ${bad.map((b) => b.req.workloadId).join(", ")}`,
        evidence,
      );
    } else if (flaky.length > 0) {
      set(
        "oracle_passes",
        false,
        `the gate is not deterministic: ${gateRepeats} runs on the oracle's same frozen output on ${flaky.map((f) => f.workload).join(", ")} gave different verdicts`,
        evidence,
      );
    } else if (notRun > 0 || determinism.some((d) => d.same === null)) {
      set(
        "oracle_passes",
        false,
        `not run: ${notRun} oracle trial(s) could not run (ours, not the kit)`,
        evidence,
      );
    } else {
      // captured references: a different baseline must agree through the same gate
      let crossCheck: string | null = null;
      if (captureWorkloads.size > 0) {
        const independent = baselines.filter((b) => b !== contenderOf(spec, oracle));
        if (independent.length === 0) {
          crossCheck = `the reference captured from oracle '${oracle.id}' has no independent baseline (a different implementation) to agree with it`;
        } else {
          for (const [w, ids] of captureWorkloads) {
            const agree = baselineRes.filter(
              (r) => independent.includes(r.req.contenderId) && r.req.workloadId === w,
            );
            const ok = agree.some((r) => allPass(r.verdicts, ids));
            if (!ok) {
              crossCheck = `the reference captured for ${w} is not confirmed: no independent baseline (${independent.join(", ")}) passed ${ids.join(", ")} on it`;
              break;
            }
          }
        }
      }
      if (crossCheck) set("oracle_passes", false, crossCheck, evidence);
      else
        set(
          "oracle_passes",
          true,
          `oracle '${oracle.id}' passed ${oracleGates.join(", ")} on ${ran.length}/${workloads.length} workload(s); the gate gave the same verdict ${gateRepeats} times on ${determinismWorkloads.join(", ")}${captureWorkloads.size > 0 ? `; captured reference(s) for ${[...captureWorkloads.keys()].join(", ")} confirmed on a fresh computer and by an independent baseline` : ""}`,
          evidence,
        );
    }
  }
  // An unproven capture is rolled back: the next repair starts from the designer's kit.
  if (captured.length > 0 && !results.get("oracle_passes")?.pass) {
    for (const rel of captured) await rm(path.join(kit.dir, rel), { force: true });
    captured.length = 0;
  }

  // do_less_fails
  {
    const doLess = spec.proof.do_less;
    const evidence: string[] = [];
    const passed: string[] = [];
    const notRun: string[] = [];
    for (const { overlay, runs } of doLessRes) {
      const last = runs[runs.length - 1];
      if (!last || last.infra) {
        notRun.push(overlay.id);
        evidence.push(`do-less '${overlay.id}': not run (${last?.infra ?? "no workload"})`);
        continue;
      }
      if (allPass(last.verdicts, gateIds) && runs.length === workloads.length) {
        passed.push(`'${overlay.id}' passed ${gateIds.join(", ")} on ${workloads.join(", ")}`);
        evidence.push(
          `do-less '${overlay.id}' (${doLessKind(overlay)}): passed every gate on every workload`,
        );
      } else {
        const gates = failedGates(last.verdicts, gateIds);
        evidence.push(
          `do-less '${overlay.id}' (${doLessKind(overlay)}): failed ${gates.join(", ")} on ${last.req.workloadId}: ${quote(last.verdicts?.[gates[0]!]?.reason ?? "no verdict")}`,
        );
      }
    }
    if (mutation) {
      evidence.push(
        `mutation kill rate on the oracle: ${mutation.killed}/${mutation.total}${mutation.survivors.length ? `; survivors: ${mutation.survivors.join(", ")}` : ""}`,
      );
    }
    const target = deps.mutation?.target ?? DEFAULT_MUTATION_TARGET;
    const kinds = doLess.map(doLessKind);
    if (doLess.length === 0) {
      set(
        "do_less_fails",
        false,
        "the kit has no do-less variant: nothing shows the gate refuses work that was skipped",
        evidence,
      );
    } else if (passed.length > 0) {
      set("do_less_fails", false, `${DO_LESS_PASSED}: ${passed.join("; ")}`, evidence);
    } else if (notRun.length > 0) {
      set(
        "do_less_fails",
        false,
        `not run: do-less ${notRun.map((x) => `'${x}'`).join(", ")} could not run (ours, not the kit)`,
        evidence,
      );
    } else if (kinds.every((k) => k === "noop")) {
      set(
        "do_less_fails",
        false,
        "the only do-less variant is a no-op, which is too weak to show the gate discriminates: add a partial oracle (the oracle with one contract clause removed) or a cheat that skips real work",
        evidence,
      );
    } else if (mutation && mutation.total > 0 && mutation.killed / mutation.total < target) {
      set(
        "do_less_fails",
        false,
        `the hidden tests killed ${mutation.killed}/${mutation.total} mutants of the oracle, under the ${Math.round(target * 100)}% target; survivors: ${mutation.survivors.slice(0, 6).join(", ")}`,
        evidence,
      );
    } else {
      set(
        "do_less_fails",
        true,
        `every do-less variant fails the gate (${doLess.map((o) => `'${o.id}'`).join(", ")})${mutation && mutation.total > 0 ? `; the hidden tests killed ${mutation.killed}/${mutation.total} oracle mutants` : ""}`,
        evidence,
      );
    }
  }

  // smoke_passes
  {
    const evidence: string[] = [];
    const bad: string[] = [];
    let notRun = 0;
    if (subjects.length === 0) bad.push("the kit has no subject contender");
    for (const r of smokeRes) {
      const c = r.req.contenderId;
      if (r.infra) {
        notRun++;
        evidence.push(`smoke ${c} on ${first}: not run (${r.infra})`);
        continue;
      }
      const o = r.outcome!;
      const missing = collectedOn(spec, first)
        .filter((q) => trialValues(o.metrics, q.metric).length === 0)
        .map((q) => q.metric);
      const noVerdict = gateIds.filter((g) => r.verdicts?.[g]?.status !== "verdict");
      const failed = failedGates(r.verdicts, gateIds);
      // The contender's own gate reason is withheld (rule 4): only gate ids and verdicts.
      evidence.push(
        `smoke ${c} on ${first}: runner ${o.status}; ${gateIds.map((g) => `${g} ${r.verdicts?.[g]?.pass ? "pass" : "fail"}`).join(", ")}; metrics ${missing.length ? `missing ${missing.join(", ")}` : "collected"}`,
      );
      if (o.status !== "ok") bad.push(`'${c}' did not finish on ${first} (${o.status})`);
      else if (noVerdict.length > 0)
        bad.push(`gate ${noVerdict.join(", ")} gave no verdict for '${c}' on ${first}`);
      else if (DETERMINISTIC(spec, c) && failed.length > 0)
        bad.push(`'${c}' failed gate ${failed.join(", ")} on ${first}`);
      // An agent's cost may come from provider-side metering, not its outputs: noted, not failed.
      else if (missing.length > 0 && DETERMINISTIC(spec, c))
        bad.push(`'${c}' left no ${missing.join(", ")} on ${first}`);
    }
    const profile = spec.env?.profile ?? "base";
    if (bad.length > 0) set("smoke_passes", false, `smoke run failed: ${bad.join("; ")}`, evidence);
    else if (notRun > 0)
      set(
        "smoke_passes",
        false,
        "not run: the smoke trial could not run (ours, not the kit)",
        evidence,
      );
    else
      set(
        "smoke_passes",
        true,
        `${subjects.map((s) => `'${s}'`).join(", ")} ran on ${first} on the real profile (${profile}) with a gate verdict and every measured metric collected`,
        evidence,
      );
  }

  // regression_scores_lower
  if (!regression) {
    set("regression_scores_lower", false, "the kit has no planted regression (proof.regression)");
  } else if (!regressionRes) {
    set("regression_scores_lower", false, "not run");
  } else {
    const { honest, planted } = regressionRes;
    const all = [...honest, ...planted];
    const evidence: string[] = [];
    if (all.some((r) => r.infra)) {
      set(
        "regression_scores_lower",
        false,
        `not run: ${all.filter((r) => r.infra).length} regression sample(s) could not run (ours, not the kit)`,
        all.filter((r) => r.infra).map((r) => `${r.req.label}: ${r.infra}`),
      );
    } else {
      const passing = (rs: GatedRun[]) => rs.filter((r) => allPass(r.verdicts, gateIds));
      const hp = passing(honest);
      const pp = passing(planted);
      evidence.push(
        `gate passes: honest ${hp.length}/${honest.length}, planted ${pp.length}/${planted.length} on ${first}`,
      );
      const lowerOn: string[] = [];
      if (pp.length < hp.length) lowerOn.push("the gate tally");
      for (const q of measuredOn(spec, first)) {
        const h = hp.flatMap((r) => trialValues(r.outcome!.metrics, q.metric));
        const p = pp.flatMap((r) => trialValues(r.outcome!.metrics, q.metric));
        if (h.length === 0 || p.length === 0) {
          evidence.push(`${q.id}: no samples to compare`);
          continue;
        }
        const worse =
          q.better === "lower" ? median(p) > Math.max(...h) : median(p) < Math.min(...h);
        // Only the direction, never the values (rule 4).
        evidence.push(
          `${q.id}: planted median ${worse ? "worse than every" : "not worse than every"} honest sample`,
        );
        if (worse) lowerOn.push(q.id);
      }
      const n = `n=${repeats}`;
      if (lowerOn.length > 0) {
        set(
          "regression_scores_lower",
          true,
          `planted regression '${regression.id}' scored lower on ${lowerOn.join(", ")} (${n} each)`,
          evidence,
        );
      } else {
        const on = measuredOn(spec, first).map((q) => q.id);
        set(
          "regression_scores_lower",
          false,
          `planted regression '${regression.id}' did not score lower on ${on.length ? on.join(", ") : "any measured requirement"} (${n})`,
          evidence,
        );
      }
    }
  }

  // baselines_in_range
  {
    const evidence: string[] = [];
    const bad: string[] = [];
    let notRun = 0;
    if (baselines.length === 0)
      bad.push("the kit has no baseline contender (role: baseline) to check the gate against");
    for (const r of baselineRes) {
      const { contenderId: c, workloadId: w } = r.req;
      if (r.infra) {
        notRun++;
        evidence.push(`baseline ${c} on ${w}: not run (${r.infra})`);
        continue;
      }
      const failed = failedGates(r.verdicts, gateIds);
      const missing = collectedOn(spec, w)
        .filter((q) => trialValues(r.outcome!.metrics, q.metric).length === 0)
        .map((q) => q.metric);
      const negative = collectedOn(spec, w)
        .filter((q) => trialValues(r.outcome!.metrics, q.metric).some((v) => v < 0))
        .map((q) => q.metric);
      evidence.push(
        `baseline ${c} on ${w}: ${gateIds.map((g) => `${g} ${r.verdicts?.[g]?.pass ? "pass" : "fail"}`).join(", ")}; metrics ${missing.length ? `missing ${missing.join(", ")}` : "present"}`,
      );
      if (r.outcome!.status !== "ok") bad.push(`baseline '${c}' did not finish on ${w}`);
      else if (failed.length > 0)
        bad.push(`baseline '${c}' failed gate ${failed.join(", ")} on ${w}`);
      else if (missing.length > 0 && DETERMINISTIC(spec, c))
        bad.push(`baseline '${c}' left no ${missing.join(", ")} on ${w}`);
      else if (negative.length > 0)
        bad.push(
          `baseline '${c}' reported an impossible (negative) ${negative.join(", ")} on ${w}`,
        );
    }
    if (bad.length > 0) set("baselines_in_range", false, bad.join("; "), evidence);
    else if (notRun > 0)
      set(
        "baselines_in_range",
        false,
        `not run: ${notRun} baseline trial(s) could not run (ours, not the kit)`,
        evidence,
      );
    else
      set(
        "baselines_in_range",
        true,
        `baseline ${baselines.map((b) => `'${b}'`).join(", ")} passed every gate on ${workloads.length} workload(s) with every measured metric present`,
        evidence,
      );
  }

  log("proof: done", {
    trials,
    gateRuns,
    ms: now() - started,
    passed: [...results.values()].filter((r) => r.pass).map((r) => r.check),
  });
  return finish([...captured], mutation);
}

// ---------------------------------------------------------------------------------------------
// mutation kill rate

async function oracleSources(kit: LoadedKit, oracle: ProofOverlay, workloadId: string) {
  const dir = path.join(kit.dir, normalizeKitPath(oracle.dir), workloadId);
  const st = await stat(dir).catch(() => undefined);
  if (!st?.isDirectory()) return new Map<string, Uint8Array>();
  const out = new Map<string, Uint8Array>();
  for (const f of await listFiles(dir)) {
    if (isMutableSource(f)) out.set(f, new Uint8Array(await readFile(path.join(dir, f))));
  }
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

async function mutationRun(
  kit: LoadedKit,
  oracle: ProofOverlay,
  hiddenGates: string[],
  oracleRes: GatedRun[],
  deps: ProofSuiteDeps,
  runGates: (
    label: string,
    workloadId: string,
    ids: readonly string[],
    bundle: Uint8Array | null,
  ) => Promise<{ verdicts: Verdicts | null; infra: string | null }>,
  infra: string[],
): Promise<ProofSuiteReport["mutation"]> {
  // The first workload whose oracle passed and ships source files under proof/oracle/<workload>/.
  for (const r of oracleRes) {
    if (!r.outcome?.bundle || !allPass(r.verdicts, hiddenGates)) continue;
    const sources = await oracleSources(kit, oracle, r.req.workloadId);
    if (sources.size === 0) continue;
    const bundle = readBundle(r.outcome.bundle);
    // Where each oracle file landed in the frozen outputs: the entries with the same bytes.
    const placed = new Map<string, string[]>();
    for (const [f, data] of sources) {
      const at = [...bundle.entries()].filter(([, b]) => sameBytes(b, data)).map(([p]) => p);
      if (at.length > 0) placed.set(f, at);
    }
    if (placed.size === 0) continue;
    const texts = new Map(
      [...placed.keys()].map((f) => [f, new TextDecoder().decode(sources.get(f)!)] as const),
    );
    const mutants: Mutant[] = mutateOracle(texts, {
      max: deps.mutation?.max ?? DEFAULT_MAX_MUTANTS,
    });
    const outcomes = await Promise.all(
      mutants.map(async (m) => {
        const files = new Map(bundle);
        for (const p of placed.get(m.file)!) files.set(p, new TextEncoder().encode(m.content));
        const g = await runGates(
          `mutant.${m.id}`,
          r.req.workloadId,
          hiddenGates,
          writeBundle(files),
        );
        if (g.infra) {
          infra.push(g.infra);
          return { m, killed: null as boolean | null };
        }
        return { m, killed: !allPass(g.verdicts, hiddenGates) };
      }),
    );
    const ran = outcomes.filter((o) => o.killed !== null);
    return {
      total: ran.length,
      killed: ran.filter((o) => o.killed).length,
      survivors: ran.filter((o) => !o.killed).map((o) => o.m.id),
    };
  }
  return null;
}
