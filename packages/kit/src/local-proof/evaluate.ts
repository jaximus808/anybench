// TDM-219 [19.3]: the local proof's records → its typed result. Pure: the Docker side only writes
// exit codes, logs and gate.json files; every judgement is made here, so it is unit-tested without
// Docker (test/tdm219-local-proof.test.ts).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GateResultSchema } from "@anybench/core";
import { z } from "zod";
import {
  LOCAL_PROOF_CHECKS,
  LOCAL_PROOF_VARIANTS,
  type LocalProofPlan,
  type LocalProofVariant,
} from "./plan.js";

// ---------------------------------------------------------------------------------------------
// raw records (what the scripts wrote)

export interface LocalProofGateRecord {
  gateId: string;
  /** check.sh's exit code; null when it never ran. */
  checkExit: number | null;
  /** gate.json as written (unparsed); null when absent. */
  gateJson: string | null;
  /** Tail of check.sh's output. */
  log: string;
}

export interface LocalProofUnitRecord {
  variant: LocalProofVariant;
  workloadId: string;
  /** null: the unit never ran (the container died first). */
  setupExit: number | null;
  /** The oracle driver's exit code (null for do-nothing, or when setup failed). */
  driverExit: number | null;
  /** Tail of the unit's setup + driver output. */
  log: string;
  gates: LocalProofGateRecord[];
}

// ---------------------------------------------------------------------------------------------
// the result (stable: the CLI prints it with --json, the MCP server returns it)

export const LocalProofGateStatusSchema = z.enum([
  "pass",
  "fail",
  /** The gate wrote `applicable: false`: it neither passes nor fails the unit. */
  "not_applicable",
  /** check.sh wrote no valid gate.json: the kit's check is broken. */
  "no_verdict",
]);
export type LocalProofGateStatus = z.infer<typeof LocalProofGateStatusSchema>;

export const LocalProofGateResultSchema = z.object({
  gateId: z.string(),
  status: LocalProofGateStatusSchema,
  /** The gate's own reason (a proof overlay's, so it is evidence, never a contender metric). */
  reason: z.string(),
  checkExit: z.int().nullable(),
  /** Tail of check.sh's output. */
  log: z.string(),
});
export type LocalProofGateResult = z.infer<typeof LocalProofGateResultSchema>;

export const LocalProofUnitResultSchema = z.object({
  variant: z.enum(LOCAL_PROOF_VARIANTS),
  workloadId: z.string(),
  /** oracle: passed every covered gate. do-nothing: failed some gate (what the check wants). */
  ok: z.boolean(),
  reason: z.string(),
  setupExit: z.int().nullable(),
  driverExit: z.int().nullable(),
  gates: z.array(LocalProofGateResultSchema),
  /** Tail of the unit's log, for a failing unit. */
  log: z.string(),
});
export type LocalProofUnitResult = z.infer<typeof LocalProofUnitResultSchema>;

export const LocalProofCheckResultSchema = z.object({
  check: z.enum(LOCAL_PROOF_CHECKS),
  pass: z.boolean(),
  reason: z.string(),
  units: z.array(LocalProofUnitResultSchema),
});
export type LocalProofCheckResult = z.infer<typeof LocalProofCheckResultSchema>;

export const LocalProofErrorCodeSchema = z.enum([
  /** anybench.yaml or a referenced file is wrong (see `issues`). */
  "invalid_kit",
  /** The kit has no oracle the local proof can run (see the message). */
  "not_runnable",
  /** No Docker daemon answered. */
  "docker_unavailable",
  /** docker run itself failed (image pull, mount), or the proof hit its overall timeout. */
  "docker_failed",
  "timeout",
]);
export type LocalProofErrorCode = z.infer<typeof LocalProofErrorCodeSchema>;

export const LocalProofResultSchema = z.object({
  /** True only when both checks passed on every workload. */
  ok: z.boolean(),
  /** pass / fail: the checks ran. error: they could not run (see `error`). */
  status: z.enum(["pass", "fail", "error"]),
  error: z
    .object({
      code: LocalProofErrorCodeSchema,
      message: z.string(),
      issues: z.array(z.string()).default([]),
    })
    .nullable(),
  /** Absolute kit directory. */
  dir: z.string(),
  image: z.string(),
  checks: z.array(LocalProofCheckResultSchema),
  durationMs: z.int().nonnegative(),
  /** Where the records were kept (`keep: true`), else null. */
  outDir: z.string().nullable(),
});
export type LocalProofResult = z.infer<typeof LocalProofResultSchema>;

// ---------------------------------------------------------------------------------------------

const LOG_TAIL = 2000;

function tail(s: string, n = LOG_TAIL): string {
  return s.length <= n ? s : `…${s.slice(-n)}`;
}

function parseExit(s: string | null): number | null {
  if (s === null) return null;
  const t = s.trim();
  return /^\d+$/.test(t) ? Number.parseInt(t, 10) : null;
}

/** Parse one gate record into its status. Exported for tests. */
export function judgeGateRecord(r: LocalProofGateRecord): LocalProofGateResult {
  const base = { gateId: r.gateId, checkExit: r.checkExit, log: tail(r.log) };
  if (r.checkExit === null) {
    return { ...base, status: "no_verdict", reason: `${r.gateId}: the check never ran` };
  }
  let parsed: unknown;
  try {
    parsed = r.gateJson === null ? undefined : JSON.parse(r.gateJson);
  } catch {
    parsed = undefined;
  }
  const v = GateResultSchema.safeParse(parsed);
  if (!v.success) {
    const why = r.gateJson === null ? "wrote no gate.json" : "wrote an invalid gate.json";
    return {
      ...base,
      status: "no_verdict",
      reason: `${r.gateId}: check.sh ${why} (exit ${r.checkExit})`,
    };
  }
  if (v.data.applicable === false) {
    return { ...base, status: "not_applicable", reason: v.data.reason };
  }
  return { ...base, status: v.data.pass ? "pass" : "fail", reason: v.data.reason };
}

function judgeUnit(
  plan: LocalProofPlan,
  variant: LocalProofVariant,
  workloadId: string,
  rec: LocalProofUnitRecord | undefined,
): LocalProofUnitResult {
  const expected = variant === "oracle" ? plan.oracle.gates : plan.gates.map((g) => g.id);
  const base = {
    variant,
    workloadId,
    setupExit: rec?.setupExit ?? null,
    driverExit: rec?.driverExit ?? null,
    log: tail(rec?.log ?? ""),
  };
  if (rec === undefined || rec.setupExit === null) {
    return { ...base, ok: false, reason: `${variant} ${workloadId}: never ran`, gates: [] };
  }
  if (rec.setupExit !== 0) {
    return {
      ...base,
      ok: false,
      reason: `${variant} ${workloadId}: the workload's setup failed (exit ${rec.setupExit})`,
      gates: [],
    };
  }
  const gates = expected.map((id) =>
    judgeGateRecord(
      rec.gates.find((g) => g.gateId === id) ?? {
        gateId: id,
        checkExit: null,
        gateJson: null,
        log: "",
      },
    ),
  );
  const broken = gates.filter((g) => g.status === "no_verdict");
  const applicable = gates.filter((g) => g.status === "pass" || g.status === "fail");
  if (variant === "oracle") {
    if (rec.driverExit !== 0) {
      return {
        ...base,
        ok: false,
        reason: `oracle ${workloadId}: the oracle driver exited ${rec.driverExit ?? "without a status"}`,
        gates,
      };
    }
    if (broken.length > 0) {
      return { ...base, ok: false, reason: `oracle ${workloadId}: ${broken[0]!.reason}`, gates };
    }
    const failed = applicable.filter((g) => g.status === "fail");
    if (failed.length > 0) {
      return {
        ...base,
        ok: false,
        reason: `oracle failed ${failed.map((g) => `'${g.gateId}'`).join(", ")} on ${workloadId}: ${failed[0]!.reason}`,
        gates,
      };
    }
    if (applicable.length === 0) {
      return { ...base, ok: false, reason: `oracle ${workloadId}: no gate applies`, gates };
    }
    return {
      ...base,
      ok: true,
      reason: `oracle passed ${applicable.length}/${applicable.length} gate(s) on ${workloadId}`,
      gates,
    };
  }
  // do-nothing: a check that broke proves nothing; otherwise some applicable gate must fail.
  if (broken.length > 0) {
    return { ...base, ok: false, reason: `do-nothing ${workloadId}: ${broken[0]!.reason}`, gates };
  }
  const failed = applicable.filter((g) => g.status === "fail");
  if (failed.length > 0) {
    return {
      ...base,
      ok: true,
      reason: `do-nothing failed ${failed.map((g) => `'${g.gateId}'`).join(", ")} on ${workloadId}`,
      gates,
    };
  }
  if (applicable.length === 0) {
    return { ...base, ok: false, reason: `do-nothing ${workloadId}: no gate applies`, gates };
  }
  return {
    ...base,
    ok: false,
    reason: `do-nothing passed every gate on ${workloadId}: the untouched starting workspace already passes, so the gates measure no work`,
    gates,
  };
}

/** Records → the two checks. Pure. */
export function evaluateLocalProof(
  plan: LocalProofPlan,
  records: readonly LocalProofUnitRecord[],
): LocalProofCheckResult[] {
  const find = (v: LocalProofVariant, w: string) =>
    records.find((r) => r.variant === v && r.workloadId === w);
  const oracle = plan.workloads.map((w) => judgeUnit(plan, "oracle", w.id, find("oracle", w.id)));
  const nothing = plan.workloads.map((w) =>
    judgeUnit(plan, "do-nothing", w.id, find("do-nothing", w.id)),
  );
  const summary = (units: LocalProofUnitResult[], okText: string) => {
    const bad = units.filter((u) => !u.ok);
    return bad.length === 0
      ? `${okText} (${units.length}/${units.length} workloads)`
      : `${bad.length}/${units.length} workload(s) wrong; first: ${bad[0]!.reason}`;
  };
  return [
    {
      check: "oracle_passes",
      pass: oracle.length > 0 && oracle.every((u) => u.ok),
      reason: summary(oracle, `oracle '${plan.oracle.overlayId}' passed every gate it covers`),
      units: oracle,
    },
    {
      check: "do_nothing_fails",
      pass: nothing.length > 0 && nothing.every((u) => u.ok),
      reason: summary(nothing, "the untouched starting workspace failed a gate"),
      units: nothing,
    },
  ];
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Read the records the scripts wrote under `outDir/units/`. */
export async function readLocalProofRecords(
  outDir: string,
  plan: LocalProofPlan,
): Promise<LocalProofUnitRecord[]> {
  const out: LocalProofUnitRecord[] = [];
  for (const variant of LOCAL_PROOF_VARIANTS) {
    for (const w of plan.workloads) {
      const u = path.join(outDir, "units", variant, w.id);
      const gateIds = variant === "oracle" ? plan.oracle.gates : plan.gates.map((g) => g.id);
      const gates: LocalProofGateRecord[] = [];
      for (const g of gateIds) {
        const gd = path.join(u, "gates", g);
        gates.push({
          gateId: g,
          checkExit: parseExit(await readOrNull(path.join(gd, "check.exit"))),
          gateJson: await readOrNull(path.join(gd, "gate.json")),
          log: tail((await readOrNull(path.join(gd, "check.log"))) ?? ""),
        });
      }
      out.push({
        variant,
        workloadId: w.id,
        setupExit: parseExit(await readOrNull(path.join(u, "setup.exit"))),
        driverExit: parseExit(await readOrNull(path.join(u, "driver.exit"))),
        log: tail((await readOrNull(path.join(u, "trial.log"))) ?? ""),
        gates,
      });
    }
  }
  return out;
}
