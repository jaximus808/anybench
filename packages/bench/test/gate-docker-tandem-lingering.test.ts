// fix-gate-lingering: the curated kit's gates (kits/tandem-vs-claude-code hidden-tests and
// api-load) stop every contender process before they exit, so an honest todo-api trial is no
// longer failed closed as `lingering`. On docker-local (node:24, the Node major on Naïve), through
// the real gate runner (uid split, $AB_RUN), one fresh scoring container per trial:
//
// - oracle: workloads/todo-api/input + proof/oracle/todo-api. Both gates pass, nothing lingers.
// - daemon: the oracle, plus an app.ts that spawns a setsid daemon (TERM ignored) on import, so
//   every hidden-test file and the load server leave one behind. The checks stop it: nothing
//   lingers and the verdicts stand.
// - daemon, old checks: the same outputs against the checks as they were before this fix (from
//   git `main` when ANYBENCH_OLD_CHECKS_REF is set): the gate runner's own rule still fails it
//   closed as `lingering` (packages/bench gate.ts is unchanged).
// - live (optional): ANYBENCH_LIVE_BUNDLE=<out.tar.gz> scores a real trial's frozen outputs.
//
// Skips cleanly when no Docker daemon answers. Set ANYBENCH_GATE_LOG=<file> to append the outcomes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type FrozenOutputs,
  type ScoringFile,
  type TrialGateRecord,
} from "../src/index.js";

const available = await dockerLocalAvailable();
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const KIT = join(REPO, "kits/tandem-vs-claude-code");
const NS_LABEL = "anybench.test-lingering";
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const OLD_REF = process.env.ANYBENCH_OLD_CHECKS_REF;
const LIVE_BUNDLE = process.env.ANYBENCH_LIVE_BUNDLE;

const GATES: Gate[] = [
  {
    id: "hidden-tests",
    kind: "hidden-tests",
    check: "gates/hidden-tests/check.sh",
    timeout_s: 300,
  },
  { id: "api-load", kind: "custom", check: "gates/api-load/check.sh", timeout_s: 300 },
];

/** Appended to the oracle's src/app.ts: a detached daemon that ignores TERM, on every import. */
const DAEMON = `
import { spawn as spawnDaemonLingering } from "node:child_process";
spawnDaemonLingering("setsid", ["bash", "-c", "trap '' TERM; while :; do sleep 1; done"], {
  detached: true,
  stdio: "ignore",
}).unref();
`;

async function oracleWorkspace(dir: string): Promise<void> {
  await cp(join(KIT, "workloads/todo-api/input"), join(dir, "workspace"), { recursive: true });
  await cp(join(KIT, "proof/oracle/todo-api"), join(dir, "workspace"), { recursive: true });
}

async function bundle(dir: string): Promise<FrozenOutputs> {
  const file = `${dir}.tar.gz`;
  const r = spawnSync("tar", ["--format=ustar", "-czf", file, "-C", dir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
  return frozenOf(new Uint8Array(await readFile(file)));
}

function frozenOf(data: Uint8Array): FrozenOutputs {
  return { kind: "bytes", data, sha256: createHash("sha256").update(data).digest("hex") };
}

describe.skipIf(!available)(
  "Tandem kit gates leave no contender process behind (docker-local)",
  () => {
    const provider = new DockerLocalProvider({ baseImage: "node:24", labels: { [NS_LABEL]: ns } });
    const store = new MemoryComputerStore();
    const registry = createComputerRegistry({
      provider,
      store,
      pricing: { pricePerBlockMicroUsd: 0n },
    });
    const runId = newId(RunIdSchema);
    const results = new Map<string, TrialGateRecord>();
    let root = "";

    async function score(
      name: string,
      frozen: FrozenOutputs,
      scoring: ScoringFile[],
    ): Promise<void> {
      const rec = await runGates(
        {
          runId,
          trialId: newId(TrialIdSchema),
          workloadId: "todo-api",
          gates: GATES,
          frozen,
          scoring,
        },
        { registry, pollIntervalMs: 500, graceMs: 60_000, readyTimeoutMs: 600_000 },
      );
      results.set(name, rec);
    }

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "lingering-"));
      await oracleWorkspace(join(root, "oracle"));
      await oracleWorkspace(join(root, "daemon"));
      const app = join(root, "daemon/workspace/src/app.ts");
      await writeFile(app, `${await readFile(app, "utf8")}${DAEMON}`);
      const scoring = await collectScoringFiles(KIT, GATES);

      const jobs: Promise<void>[] = [
        score("oracle", await bundle(join(root, "oracle")), scoring),
        score("daemon", await bundle(join(root, "daemon")), scoring),
      ];
      if (OLD_REF) {
        // The same kit with the check scripts as they were at OLD_REF.
        const old = scoring.map((f) => {
          if (!f.path.endsWith("/check.sh")) return f;
          const r = spawnSync("git", [
            "-C",
            REPO,
            "show",
            `${OLD_REF}:kits/tandem-vs-claude-code/${f.path}`,
          ]);
          if (r.status !== 0) throw new Error(`git show ${OLD_REF}: ${r.stderr}`);
          return { ...f, data: new Uint8Array(r.stdout) };
        });
        jobs.push(score("daemon-old-checks", await bundle(join(root, "daemon")), old));
      }
      if (LIVE_BUNDLE)
        jobs.push(score("live", frozenOf(new Uint8Array(await readFile(LIVE_BUNDLE))), scoring));
      await Promise.all(jobs);
    }, 1_200_000);

    afterAll(async () => {
      const log = process.env.ANYBENCH_GATE_LOG;
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
              reason: o.result.reason,
              ms: o.duration_ms,
              log_tail: o.log_tail.slice(-400),
            },
          ]),
        ),
      }));
      if (log) await appendFile(log, `${JSON.stringify({ at: new Date().toISOString(), rows })}\n`);
      if (root) await rm(root, { recursive: true, force: true });
      await provider.dispose();
      const left = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=${NS_LABEL}=${ns}`], {
        encoding: "utf8",
      }).stdout.trim();
      if (left) spawnSync("docker", ["rm", "-f", "-v", ...left.split("\n")]);
      expect(left, "the suite leaked containers").toBe("");
    }, 120_000);

    it("the oracle passes hidden-tests and api-load, with no lingering process", () => {
      const r = results.get("oracle")!;
      expect(r.sandbox).toBe("uid-split");
      expect(r.gates["hidden-tests"]).toMatchObject({
        status: "verdict",
        result: { pass: true, reason: "16/16 hidden tests passed" },
      });
      expect(r.gates["api-load"]!.status).toBe("verdict");
      expect(r.gates["api-load"]!.result.pass).toBe(true);
      expect(r.gates["api-load"]!.result.reason).toMatch(
        /^p95 [\d.]+ ms at 50 req\/s over 1000 requests, 0 errors$/,
      );
      expect(r.scoring_computer?.destroyed).toBe(true);
    });

    it("a contender that leaves a TERM-proof setsid daemon is stopped by the checks: nothing lingers", () => {
      const r = results.get("daemon")!;
      for (const id of ["hidden-tests", "api-load"]) {
        const g = r.gates[id]!;
        expect(g.status, `${id}: ${g.result.reason}`).toBe("verdict");
        expect(g.log_tail, id).toMatch(/stopping contender processes:.*bash/);
        expect(g.log_tail, id).not.toMatch(/still running after KILL/);
      }
      expect(r.gates["hidden-tests"]!.result).toMatchObject({
        pass: true,
        reason: "16/16 hidden tests passed",
      });
    });

    it.skipIf(!OLD_REF)(
      "the same daemon against the old checks still fails closed as lingering (runner rule intact)",
      () => {
        const r = results.get("daemon-old-checks")!;
        for (const id of ["hidden-tests", "api-load"]) {
          expect(r.gates[id]).toMatchObject({
            status: "lingering",
            kit_suspect: false,
            result: { pass: false },
          });
          expect(r.gates[id]!.result.reason).toMatch(
            /contender process\(es\) still running when the check exited/,
          );
        }
      },
    );

    it.skipIf(!LIVE_BUNDLE)(
      "the live trial's frozen outputs pass with no lingering process",
      () => {
        const r = results.get("live")!;
        expect(r.gates["hidden-tests"]).toMatchObject({
          status: "verdict",
          result: { pass: true },
        });
        expect(r.gates["api-load"]).toMatchObject({ status: "verdict", result: { pass: true } });
      },
    );
  },
);
