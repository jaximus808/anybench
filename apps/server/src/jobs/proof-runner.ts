// TDM-44 [4.12]: the proof suite's ProofRunner over a real ComputeProvider (docker-local in tests,
// Naïve live), through the SAME path a contender trial takes, so proof measures exactly what
// trials measure:
//
//   runTrial  bench executeTrial: fork env.env_id (the subject image), write the workload +
//             trial.json, launch the runner binary detached, follow status.json (file-only: no
//             ingest, proof trials have no `trials` row), pull out.tar.gz through the fs/read
//             fallback, destroy the computer. The job is orchestrator/trial-source preparedJob
//             (workspace prep, recipe env, verbs) plus the overlay: its env on top, and ONLY its
//             own files (overlay.dir and driver_patch) written under ~/kit on the fork. The
//             metric rows come from bench collect() over the frozen collector files.
//   runGates  bench runGates on a FRESH scoring computer forked from env.detail.scoring_snapshot_id
//             (never the subject image), with the scoring bundle read from the kit dir at call
//             time (so a reference the proof just captured is in it).
//
// Every computer goes through a ComputerRegistry, so it is tagged `ab-<run>-<proof trial>` and has
// a `computers` row the reaper can find; the row carries no trial id (proof trials have no
// `trials` row for the FK) and no run id (proof compute is our pipeline's cost, not billed to the
// run), except for an uploaded kit's proof (TDM-218, `billToRun`), whose rows carry the run id so
// the ledger bills them with the run like any run-level computer. The
// executor and the gate runner destroy their computers on every path; `sweep()` destroys anything
// tagged with this proof that is still up (call it in `finally`).
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  collect,
  collectScoringFiles,
  COLLECTOR_OUTPUT_FILES,
  executeTrial,
  GateInfraError,
  GateKitError,
  MemoryTrialExecStore,
  runGates,
  type CollectorInput,
  type ExecutorDeps,
  type TrialPrepared,
} from "@anybench/bench";
import { isAgentDriver, newId, TrialIdSchema, type KitSpec } from "@anybench/core";
import {
  createComputerRegistry,
  KIT_DIR_REL,
  MemoryComputerStore,
  type ComputerStore,
} from "@anybench/envs";
import {
  canonicalKitPath,
  hashKitPaths,
  KIT_LAYOUT,
  normalizeKitPath,
  ProofInfraError,
  readBundle,
  type LoadedKit,
  type ProofMetric,
  type ProofRunner,
  type ProofTrialOutcome,
} from "@anybench/kit";
import {
  hyphenateUuid,
  parseTrialTag,
  runTagPrefix,
  type ComputeProvider,
} from "@anybench/providers";
import { computerPricing } from "../lib/computer-store.js";
import { kitComputerSize, type EnvBuildDetail } from "../orchestrator/env-build.js";
import type { EnvBuild } from "../orchestrator/ports.js";
import { preparedJob, trialProxyCap } from "../orchestrator/trial-source.js";

export interface ProviderProofRunnerOptions {
  provider: ComputeProvider;
  kit: LoadedKit;
  /** The run's env build: env_id = the subject image, detail.scoring_snapshot_id = the scoring image. */
  env: EnvBuild;
  /** The run (tags only: `ab-<run>-<proof trial>`). */
  runId: string;
  /** Where computers rows go: drizzleComputerStore(db) in the worker, memory in tests. */
  store?: ComputerStore;
  /**
   * TDM-218: an uploaded kit's proof runs for the user, not for our own kit design, so its
   * computers rows carry the run id and are billed like the run's other run-level computers (cost +
   * COMPUTE_MARKUP_BPS, only when the run bills compute: never for our infra failures or our
   * cancels). Off: the rows carry no run id and the proof is our cost (a generated kit's, covered
   * by RUN_FEE_MICRO_USD).
   */
  billToRun?: boolean;
  /** Integer micro-USD per billing block, for the rows' cost. */
  pricePerBlockMicroUsd?: bigint;
  /** Naïve proxy keys for agent contenders (AB_TOKEN_SOURCE=naive_proxy): proxyDepsFromConfig. */
  naiveProxy?: ExecutorDeps["naiveProxy"];
  /** Ceiling of each proof trial's proxy spend cap (TRIAL_PROXY_CAP_MICRO_USD). */
  proxyCapMicroUsd?: bigint;
  /** Backoff before retrying our own failure (default 10 s, doubled for gates). */
  retryBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the executor's timing (tests). */
  timing?: ExecutorDeps["timing"];
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface ProviderProofRunner extends ProofRunner {
  /** Proof trial ids this runner created (their tags are `ab-<run>-<id>`). */
  readonly trialIds: readonly string[];
  /** Destroy every provider computer of this run tagged with one of our proof trial ids. */
  sweep(): Promise<string[]>;
}

/**
 * A ComputerStore that writes the row without a trial id (proof trials have no `trials` row), and
 * without a run id unless `billRunId` is set (see the header).
 */
export function proofStore(base: ComputerStore, billRunId: string | null): ComputerStore {
  // Bound explicitly: a class-based store (MemoryComputerStore) keeps its methods on the prototype.
  return {
    insert: (row) => base.insert({ ...row, runId: billRunId, trialId: null }),
    update: (id, patch) => base.update(id, patch),
    get: (id) => base.get(id),
    findByProviderId: (provider, providerId) => base.findByProviderId(provider, providerId),
  };
}

/** Collector outputs present in the frozen bundle, in bench's CollectorInput shape. */
function collectorInputs(files: Map<string, Uint8Array>): CollectorInput[] {
  const out: CollectorInput[] = [];
  for (const [collector, file] of Object.entries(COLLECTOR_OUTPUT_FILES)) {
    const data = files.get(file);
    if (!data) continue;
    if (collector === "proxy-calls") continue; // provider-side metering, not a frozen file
    out.push({ collector, raw: new TextDecoder().decode(data) } as CollectorInput);
  }
  return out;
}

/** The trial-level metric rows of a frozen bundle (labelled per-command rows are left out). */
export function bundleMetrics(spec: KitSpec, bundle: Uint8Array): ProofMetric[] {
  const { metrics: rows } = collect(collectorInputs(readBundle(bundle)), spec.requirements);
  return rows
    .filter((m) => m.level === "trial" && m.labels === undefined)
    .map((m) => ({
      name: m.name,
      // Compared only for ordering (regression), never added up as money.
      value: typeof m.value === "bigint" ? Number(m.value) : m.value,
      level: m.level,
      ...(m.gate_id ? { gate_id: m.gate_id } : {}),
    }));
}

async function kitFile(kit: LoadedKit, rel: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(kit.dir, rel)));
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function providerProofRunner(opts: ProviderProofRunnerOptions): ProviderProofRunner {
  const sleep = opts.sleep ?? realSleep;
  const retryBackoffMs = opts.retryBackoffMs ?? 10_000;
  /** A gate run whose scoring computer could not start (GateInfraError) is retried twice. */
  const withGateRetries = async <T>(f: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return await f();
      } catch (err) {
        if (!(err instanceof GateInfraError) || i >= 2) throw err;
        log("proof gate: infra retry", { err: err.message, attempt: i + 1 });
        await sleep(retryBackoffMs * 2 ** i);
      }
    }
  };
  const { provider, kit, env } = opts;
  const spec = kit.spec;
  const detail = (env.detail ?? {}) as Partial<EnvBuildDetail>;
  const kitDir = detail.kit_dir ?? KIT_DIR_REL;
  const store = proofStore(
    opts.store ?? new MemoryComputerStore(),
    opts.billToRun ? opts.runId : null,
  );
  const registry = createComputerRegistry({
    provider,
    store,
    pricing: computerPricing(provider, opts.pricePerBlockMicroUsd ?? 0n),
  });
  const trialIds: string[] = [];
  const log = opts.log ?? (() => undefined);
  if (!env.env_id) throw new ProofInfraError("proof: the run has no built env image (env_id)");

  /** Files of one overlay for the fork: its own dir and its driver patch, nothing else of proof/. */
  async function overlayFiles(
    req: Parameters<ProofRunner["runTrial"]>[0],
  ): Promise<NonNullable<TrialPrepared["files"]>> {
    const o = req.overlay;
    if (!o) return [];
    const files: NonNullable<TrialPrepared["files"]> = [];
    const forbidden = [KIT_LAYOUT.gatesDir, KIT_LAYOUT.referenceDir];
    const dir = normalizeKitPath(o.dir);
    if (forbidden.some((d) => dir === d || dir.startsWith(`${d}/`))) {
      throw new Error(`overlay '${o.id}': its dir ${o.dir} may not be under gates/ or reference/`);
    }
    // The oracle's files reach the fork only for the oracle's own trial (no contender runs then).
    const { hash, problems } = await hashKitPaths(kit.dir, [dir]);
    if (problems.length > 0) throw new Error(`overlay '${o.id}': cannot ship ${o.dir}`);
    for (const f of hash.files) {
      files.push({
        path: `${kitDir}/${f.path}`,
        content: await kitFile(kit, f.path),
        mode: f.path.endsWith(".sh") ? 0o755 : 0o644,
      });
    }
    if (o.driver_patch !== undefined) {
      const patch = canonicalKitPath(o.driver_patch);
      const resolved = kit.contenders.find((c) => c.id === req.contenderId);
      const driver = resolved ? canonicalKitPath(resolved.driver) : undefined;
      if (!patch || !driver) throw new Error(`overlay '${o.id}': no driver to patch`);
      if (forbidden.some((d) => patch.startsWith(`${d}/`))) {
        throw new Error(`overlay '${o.id}': driver_patch may not come from gates/ or reference/`);
      }
      // A driver_patch is a whole replacement driver, copied over the contender's driver path.
      files.push({ path: `${kitDir}/${driver}`, content: await kitFile(kit, patch), mode: 0o755 });
    }
    return files;
  }

  return {
    trialIds,

    async runTrial(req, signal) {
      const trialId = newId(TrialIdSchema);
      trialIds.push(trialId);
      const job = preparedJob(spec, req.contenderId, req.workloadId, detail);
      const prepared: TrialPrepared = {
        job: {
          ...job,
          env: { ...(job.env ?? {}), ...(req.overlay?.env ?? {}) },
          // No ingest, no upload plans: the executor pulls the bundle through fallbackUpload.
          upload: { ...(job.upload ?? {}), enabled: false },
        },
        computer: { ...kitComputerSize(spec), snapshotId: env.env_id! },
        secrets: {},
        files: await overlayFiles(req),
      };
      // Model tokens through the Naïve proxy, as kitTrialSource does for a contender trial: the
      // executor mints the per-trial key, enforces the cap and revokes it on every path.
      if (prepared.job.env?.AB_TOKEN_SOURCE === "naive_proxy") {
        const contender = spec.contenders.find((c) => c.id === req.contenderId)!;
        const e = prepared.job.env;
        const model =
          (isAgentDriver(contender.driver) ? contender.driver.model : undefined) ??
          e.CC_MODEL ??
          e.ANTHROPIC_MODEL;
        if (!opts.naiveProxy || !model) {
          throw new ProofInfraError(
            `proof trial ${req.label}: the contender takes model tokens from the Naïve proxy, which is not configured`,
          );
        }
        prepared.naive_proxy = {
          model,
          ...(e.ANTHROPIC_SMALL_FAST_MODEL ? { smallFastModel: e.ANTHROPIC_SMALL_FAST_MODEL } : {}),
          capMicroUsd: trialProxyCap(contender.driver, opts.proxyCapMicroUsd),
        };
      }
      const store = new MemoryTrialExecStore();
      store.seed({ id: trialId, run_id: opts.runId });
      let bundle: Uint8Array | null = null;
      let lastWarning = "";
      const record = (level: string) => (obj: object, msg?: string) => {
        const err = (obj as { err?: unknown }).err;
        if (level !== "info")
          lastWarning = `${msg ?? ""}${err ? `: ${String(err)}` : ""}`.slice(0, 300);
        log(`proof trial ${level}: ${msg ?? ""}`, {
          label: req.label,
          ...(err ? { err: String(err) } : {}),
        });
      };
      const deps: ExecutorDeps = {
        logger: { info: () => undefined, warn: record("warn"), error: record("error") },
        store,
        registry,
        source: { prepare: async () => prepared },
        ingest: null,
        owner: `proof~${Date.now()}`,
        fallbackUpload: async (_t, bytes) => {
          bundle = bytes;
          return { key: `proof/${opts.runId}/${trialId}/out.tar.gz` };
        },
        ...(opts.timing ? { timing: opts.timing } : {}),
        ...(opts.naiveProxy ? { naiveProxy: opts.naiveProxy } : {}),
      };
      log("proof trial: start", { label: req.label, trialId });
      let out = await executeTrial(deps, trialId, signal ? { signal } : {});
      // One retry for our own trouble (a 429 on create, a lost runner), as trial.execute does.
      // Our own trouble (a 429 "at capacity" on create, a lost runner) is retried as a new
      // attempt after a backoff, as trial.execute does, until the executor's tries run out.
      while (out.kind === "retry" && !signal?.aborted) {
        await sleep(Math.max(retryBackoffMs, Math.min(out.delay_ms, 60_000)));
        out = await executeTrial(deps, trialId, { retryNow: true, ...(signal ? { signal } : {}) });
      }
      const t = (await store.get(trialId))!;
      log("proof trial: end", {
        label: req.label,
        kind: out.kind,
        state: t.state,
        failure_class: t.failure_class,
      });
      const frozen = bundle as Uint8Array | null;
      const metrics = frozen ? bundleMetrics(spec, frozen) : [];
      let status: ProofTrialOutcome["status"];
      if (out.kind === "collected") status = "ok";
      else if (out.kind === "final" && out.state === "failed_subject") status = "subject_failed";
      else status = "infra_failed";
      if (status === "infra_failed") {
        return {
          status,
          detail: `trial ${out.kind}${t.failure_class ? ` (${t.failure_class})` : ""}${lastWarning ? `: ${lastWarning}` : ""}`,
          bundle: frozen,
          metrics,
        };
      }
      return {
        status,
        detail: `runner exit ${t.exit_code ?? "?"}${t.failure_class ? `, ${t.failure_class}` : ""}`,
        bundle: frozen,
        metrics,
      };
    },

    async runGates(req, signal) {
      if (signal?.aborted) throw new ProofInfraError("aborted");
      const gates = spec.gates.filter((g) => req.gateIds.includes(g.id));
      const trialId = newId(TrialIdSchema);
      trialIds.push(trialId);
      try {
        const record = await withGateRetries(async () =>
          runGates(
            {
              runId: opts.runId,
              trialId,
              workloadId: req.workloadId,
              gates,
              frozen: req.bundle
                ? { kind: "bytes", data: req.bundle }
                : { kind: "missing", reason: "the trial froze no outputs" },
              scoring: await collectScoringFiles(kit.dir, gates),
              profile: detail.scoring_snapshot_id ? { snapshotId: detail.scoring_snapshot_id } : {},
              subjectSnapshotIds: [env.env_id!],
            },
            { registry },
          ),
        );
        return {
          gates: Object.fromEntries(
            Object.entries(record.gates).map(([id, o]) => [
              id,
              {
                pass: o.result.pass,
                reason: o.result.reason,
                applicable: o.result.applicable,
                status: o.status,
                kit_suspect: o.kit_suspect,
              },
            ]),
          ),
        };
      } catch (err) {
        if (err instanceof GateInfraError) throw new ProofInfraError(`gate infra: ${err.message}`);
        if (err instanceof GateKitError) {
          // The kit's fault (a check path missing from the bundle): every gate fails closed.
          return {
            gates: Object.fromEntries(
              req.gateIds.map((id) => [
                id,
                {
                  pass: false,
                  reason: `kit error: ${err.message}`,
                  applicable: true,
                  status: "check_failed",
                  kit_suspect: true,
                },
              ]),
            ),
          };
        }
        throw err;
      }
    },

    async sweep() {
      const ours = new Set(trialIds);
      const destroyed: string[] = [];
      let listed;
      try {
        listed = await provider.list({
          tagPrefix: runTagPrefix(opts.runId),
          includeDestroyed: false,
        });
      } catch {
        return destroyed;
      }
      for (const c of listed) {
        const mine = (c.tags ?? []).some((tag) => {
          const t = parseTrialTag(tag);
          return t !== null && ours.has(hyphenateUuid(t.trialId));
        });
        if (!mine) continue;
        await provider.destroy(c.id).catch(() => undefined);
        destroyed.push(c.id);
      }
      return destroyed;
    },
  };
}
