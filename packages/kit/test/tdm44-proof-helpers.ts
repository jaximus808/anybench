// TDM-44 test helpers: a host-side ProofRunner. Trials are SIMULATED by a behaviour function
// (the host has no GNU time / hyperfine / rg); gates are REAL: the kit's own check.sh runs with
// bash on the unpacked frozen outputs, exactly as the gate runner calls it
// (`check.sh <frozen-out> <workload-id> <gate.json>`, AB_RUN / AB_RUN_DIR for hidden tests).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readBundle,
  writeBundle,
  type LoadedKit,
  type ProofGateOutcome,
  type ProofMetric,
  type ProofRunner,
  type ProofTrialOutcome,
  type ProofTrialRequest,
} from "../src/index.js";

export type TrialBehaviourTdm44 = (
  req: ProofTrialRequest,
  n: number,
) => {
  files: Record<string, string | Uint8Array>;
  metrics?: ProofMetric[];
  status?: ProofTrialOutcome["status"];
};

export interface HostRunnerTdm44 extends ProofRunner {
  trials: ProofTrialRequest[];
  gateCalls: { label: string; workloadId: string }[];
}

/** A ProofRunner whose trials come from `behave` and whose gates run the kit's real check.sh. */
export function hostProofRunnerTdm44(kit: LoadedKit, behave: TrialBehaviourTdm44): HostRunnerTdm44 {
  const trials: ProofTrialRequest[] = [];
  const gateCalls: { label: string; workloadId: string }[] = [];
  let n = 0;
  return {
    trials,
    gateCalls,
    async runTrial(req) {
      trials.push(req);
      const b = behave(req, n++);
      const files = new Map<string, Uint8Array>();
      for (const [p, v] of Object.entries(b.files)) {
        files.set(p, typeof v === "string" ? new TextEncoder().encode(v) : v);
      }
      return {
        status: b.status ?? "ok",
        detail: "simulated",
        bundle: writeBundle(files),
        metrics: b.metrics ?? [],
      };
    },
    async runGates(req): Promise<ProofGateOutcome> {
      gateCalls.push({ label: req.label, workloadId: req.workloadId });
      const work = mkdtempSync(path.join(tmpdir(), "tdm44-gate-"));
      try {
        const frozen = path.join(work, "frozen");
        mkdirSync(frozen);
        if (req.bundle) {
          for (const [p, data] of readBundle(req.bundle)) {
            mkdirSync(path.dirname(path.join(frozen, p)), { recursive: true });
            writeFileSync(path.join(frozen, p), data);
          }
        }
        const runDir = path.join(work, "run");
        cpSync(frozen, runDir, { recursive: true });
        const abRun = path.join(work, "ab-run");
        writeFileSync(abRun, '#!/usr/bin/env bash\nexec "$@"\n');
        chmodSync(abRun, 0o755);
        const gates: ProofGateOutcome["gates"] = {};
        for (const id of req.gateIds) {
          const gate = kit.gates.find((g) => g.id === id)!;
          const verdict = path.join(work, `${id}.json`);
          const r = spawnSync(
            "bash",
            [path.join(kit.dir, gate.check), frozen, req.workloadId, verdict],
            {
              encoding: "utf8",
              env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                AB_RUN: abRun,
                AB_RUN_DIR: runDir,
                HOME: work,
              },
              timeout: 120_000,
            },
          );
          let parsed: { pass: boolean; reason: string } | null = null;
          try {
            parsed = JSON.parse(readFileSync(verdict, "utf8")) as { pass: boolean; reason: string };
          } catch {
            parsed = null;
          }
          gates[id] =
            r.status === 0 && parsed
              ? {
                  pass: parsed.pass,
                  reason: parsed.reason,
                  applicable: true,
                  status: "verdict",
                  kit_suspect: false,
                }
              : {
                  pass: false,
                  reason: `gate ${id}: check exited ${r.status}: ${(r.stderr || "").slice(0, 200)}`,
                  applicable: true,
                  status: r.status === 0 ? "no_verdict" : "check_failed",
                  kit_suspect: true,
                };
        }
        return { gates };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

/** A temp copy of a kit dir (tests edit it). */
export function copyKitTdm44(src: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tdm44-kit-"));
  cpSync(src, dir, { recursive: true });
  return dir;
}

// ---- the cli example's behaviour (ripgrep vs GNU grep, packages/kit/examples/cli)

/** Distinctive metric values: rule 4 says none of these may appear in a proof reason. */
export const TDM44_HONEST_WALL = 0.0123457;
export const TDM44_PLANTED_WALL = 0.3187654;
export const TDM44_RSS = 5_432_109;

/**
 * Simulated cli trials: the honest contenders print the matches (the committed reference), the
 * truncating do-less prints its first line, first-match-only one line per file, the planted
 * regression prints the right lines but takes longer.
 */
export function cliBehaviourTdm44(exampleDir: string): TrialBehaviourTdm44 {
  return (req, n) => {
    const ref = readFileSync(
      path.join(exampleDir, "reference/same-matches", req.workloadId, "stdout.txt"),
      "utf8",
    );
    let stdout = ref;
    const lines = ref.split("\n").filter(Boolean);
    if (req.overlay?.id === "truncated-output") stdout = `${lines[0]}\n`;
    if (req.overlay?.id === "first-match-only") {
      const seen = new Set<string>();
      stdout = `${lines.filter((l) => !seen.has(l.split(":")[0]!) && seen.add(l.split(":")[0]!)).join("\n")}\n`;
    }
    const planted = req.overlay?.id === "planted-delay";
    const wall = (planted ? TDM44_PLANTED_WALL : TDM44_HONEST_WALL) + n * 1e-7;
    return {
      files: { "cli/stdout.txt": stdout, "cli/exit_code": "0\n", "cli/stderr.txt": "" },
      metrics: [
        { name: "wall_s", value: wall, gate_id: "same-matches", level: "trial" },
        { name: "peak_rss_bytes", value: TDM44_RSS + n, gate_id: "same-matches", level: "trial" },
      ],
    };
  };
}
