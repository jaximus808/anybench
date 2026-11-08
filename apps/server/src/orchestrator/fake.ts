// In-memory stand-ins for the orchestrator's ports (TDM-54): FakeAgentStages and FakePipeline.
// Used by the orchestrator tests, and by E6 tickets to test one real role against fakes for the
// rest. Each call is recorded. Given a `naive` client (FakeNaive in tests), every agent stage
// also opens a Naïve session with `ctx.idempotencyKey` and writes its agent_sessions row, so a
// rerun stage replays the same session and a cancel has something to cancel.
import {
  FAILURE_CLASSES,
  PROOF_CHECKS,
  type KitSpec,
  type ProjectDigest,
  type ProofCheckResult,
} from "@anybench/core";
import { AGENT_ROLE_KEY, type NaiveClient } from "@anybench/naive";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentSessions } from "../db/schema/agent_sessions.js";
import {
  stageOk,
  type AgentStagePort,
  type Analysis,
  type EnvBuild,
  type PipelinePort,
  type Research,
  type StageContext,
  type StageResult,
  type StageTrial,
  type Understanding,
} from "./ports.js";

export type FakeRole = "understander" | "researcher" | "kit_designer" | "analyst";

export interface FakeStageCall {
  role: FakeRole;
  key: string;
}

export interface FakeAgentStagesOptions {
  /** What the kit designer returns (every visit). */
  kit: KitSpec | ((visit: number) => KitSpec);
  understanding?: Understanding;
  research?: Research;
  /** The analyst's report; default: a minimal valid report with no contender numbers. */
  report?: (input: { runId: string; kitId: string; trials: StageTrial[] }) => Analysis;
  /** Open a Naïve session per stage (idempotent on ctx.idempotencyKey) and record it. */
  naive?: { client: NaiveClient; db: Database };
  /** Roles whose session stays running until the stage is aborted (cancel tests). */
  hang?: readonly FakeRole[];
  /** Called when a hanging role starts waiting (tests kill the worker or cancel here). */
  onHang?: (role: FakeRole, ctx: StageContext) => void;
  /** Replace one role's behaviour entirely. */
  overrides?: Partial<AgentStagePort>;
}

export const FAKE_UNDERSTANDING: Understanding = {
  kind: "software",
  summary: "A fast line-oriented search tool.",
  better_means: ["same matches as grep", "less wall time"],
  risks: [],
  benchable: "ready",
  reason: "",
};

export const FAKE_RESEARCH: Research = {
  baselines: [
    {
      name: "gnu-grep",
      role: "baseline",
      source: "https://ftp.gnu.org/gnu/grep/",
      why: "the plain default",
      published_numbers: [],
    },
  ],
  sources: ["https://www.gnu.org/software/grep/"],
};

/** A report the schema accepts: no measured numbers, so nothing needs a gate to back it. */
export function minimalReport(runId: string, kitId: string, trials: StageTrial[]): Analysis {
  const failures = Object.fromEntries(FAILURE_CLASSES.map((c) => [c, 0])) as Record<
    (typeof FAILURE_CLASSES)[number],
    number
  >;
  failures.subject = trials.filter((t) => t.state === "failed_subject").length;
  failures.infra = trials.filter((t) => t.state === "failed_infra").length;
  return {
    report: {
      run_id: runId as Analysis["report"]["run_id"],
      kit_id: kitId as Analysis["report"]["kit_id"],
      answer: `Ran ${trials.length} trials.`,
      comped: false,
      contenders: [],
      where_it_breaks: [],
      bottlenecks: [],
      proof: [],
      failures,
      postmortem: null,
      generated_at: new Date().toISOString(),
    },
    md: `# Report\n\nRan ${trials.length} trials.\n`,
  };
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

export class FakeAgentStages implements AgentStagePort {
  readonly calls: FakeStageCall[] = [];
  private readonly visits = new Map<FakeRole, number>();

  constructor(private readonly opts: FakeAgentStagesOptions) {}

  private async session(ctx: StageContext, role: FakeRole, input: unknown): Promise<void> {
    this.calls.push({ role, key: ctx.idempotencyKey });
    this.visits.set(role, (this.visits.get(role) ?? 0) + 1);
    const hang = this.opts.hang?.includes(role) ?? false;
    const naive = this.opts.naive;
    if (naive) {
      const name = `anybench-fake-${role}`;
      const agent =
        (await naive.client.agents.findByName(name)) ??
        (await naive.client.agents.create({
          name,
          model: "fake-model",
          system: `fake ${role}`,
          budget: { capMicroUsd: 10_000_000n, maxTaskMicroUsd: 1_000_000n, period: "day" },
          metadata: { [AGENT_ROLE_KEY]: role },
        }));
      const s = await naive.client.sessions.create(
        {
          agentId: agent.id,
          message: JSON.stringify({ role, input }),
          budgetMicroUsd: 1_000_000n,
          metadata: { [AGENT_ROLE_KEY]: role, run_id: ctx.run.id },
        },
        { idempotencyKey: ctx.idempotencyKey },
      );
      await naive.db
        .insert(agentSessions)
        .values({
          runId: ctx.run.id,
          role,
          naiveSessionId: s.id,
          budgetMicroUsd: 1_000_000n,
          status: hang ? "running" : "done",
        })
        .onConflictDoUpdate({
          target: agentSessions.naiveSessionId,
          set: { status: hang ? "running" : "done", updatedAt: sql`now()` },
        });
      await ctx.emit([
        {
          type: "agent.message",
          source: "agent_session",
          source_id: s.id,
          severity: "info",
          actor: { kind: "agent", id: s.id },
          cost_delta_micro_usd: 0n,
          at: new Date().toISOString(),
          payload: {
            agent_role: role,
            naive_seq: 0,
            message_role: "assistant",
            text: `${role} started`,
            truncated: false,
          },
        },
      ]);
    }
    if (hang) {
      const waiting = untilAborted(ctx.signal);
      this.opts.onHang?.(role, ctx);
      await waiting;
    }
  }

  visitsOf(role: FakeRole): number {
    return this.visits.get(role) ?? 0;
  }

  async understand(
    ctx: StageContext,
    input: { digest: ProjectDigest },
  ): Promise<StageResult<unknown>> {
    if (this.opts.overrides?.understand) return this.opts.overrides.understand(ctx, input);
    await this.session(ctx, "understander", { name: input.digest.name });
    return stageOk(this.opts.understanding ?? FAKE_UNDERSTANDING);
  }

  async research(
    ctx: StageContext,
    input: { digest: ProjectDigest; understanding: Understanding },
  ): Promise<StageResult<unknown>> {
    if (this.opts.overrides?.research) return this.opts.overrides.research(ctx, input);
    await this.session(ctx, "researcher", { summary: input.understanding.summary });
    return stageOk(this.opts.research ?? FAKE_RESEARCH);
  }

  async designKit(
    ctx: StageContext,
    input: Parameters<AgentStagePort["designKit"]>[1],
  ): Promise<StageResult<{ spec: KitSpec }>> {
    if (this.opts.overrides?.designKit) return this.opts.overrides.designKit(ctx, input);
    await this.session(ctx, "kit_designer", { repair: input.previous !== null });
    const visit = this.visitsOf("kit_designer");
    const kit = typeof this.opts.kit === "function" ? this.opts.kit(visit) : this.opts.kit;
    return stageOk({ spec: kit });
  }

  async analyze(
    ctx: StageContext,
    input: Parameters<AgentStagePort["analyze"]>[1],
  ): Promise<StageResult<unknown>> {
    if (this.opts.overrides?.analyze) return this.opts.overrides.analyze(ctx, input);
    await this.session(ctx, "analyst", { trials: input.trials.length });
    const report = this.opts.report ?? ((i) => minimalReport(i.runId, i.kitId, i.trials));
    return stageOk(report({ runId: ctx.run.id, kitId: input.kit_id, trials: input.trials }));
  }
}

export interface FakePipelineOptions {
  digest: ProjectDigest;
  /** Proof results per proof call (1-based); default: all six checks pass. */
  proof?: (call: number) => ProofCheckResult[];
  estimate?: bigint;
  env?: EnvBuild;
  score?: (trials: StageTrial[]) => unknown;
}

export function passingProof(): ProofCheckResult[] {
  return PROOF_CHECKS.map((check) => ({ check, pass: true, reason: "ok", evidence: [] }));
}

export function failingProof(check: (typeof PROOF_CHECKS)[number] = "do_less_fails") {
  return passingProof().map((p) =>
    p.check === check ? { ...p, pass: false, reason: "the partial oracle passed" } : p,
  );
}

export class FakePipeline implements PipelinePort {
  readonly calls: { step: string; key: string }[] = [];
  private proofCalls = 0;

  constructor(private readonly opts: FakePipelineOptions) {}

  async ingest(ctx: StageContext): Promise<StageResult<ProjectDigest>> {
    this.calls.push({ step: "ingest", key: ctx.idempotencyKey });
    return stageOk(this.opts.digest);
  }

  async buildEnv(ctx: StageContext): Promise<StageResult<unknown>> {
    this.calls.push({ step: "buildEnv", key: ctx.idempotencyKey });
    return stageOk(this.opts.env ?? { env_id: null, detail: { fake: true } });
  }

  async prove(ctx: StageContext): Promise<StageResult<ProofCheckResult[]>> {
    this.calls.push({ step: "prove", key: ctx.idempotencyKey });
    this.proofCalls++;
    return stageOk(this.opts.proof ? this.opts.proof(this.proofCalls) : passingProof());
  }

  async estimate(ctx: StageContext): Promise<StageResult<bigint>> {
    this.calls.push({ step: "estimate", key: ctx.idempotencyKey });
    return stageOk(this.opts.estimate ?? 1_000_000n);
  }

  async score(ctx: StageContext, input: { trials: StageTrial[] }): Promise<StageResult<unknown>> {
    this.calls.push({ step: "score", key: ctx.idempotencyKey });
    return stageOk(
      this.opts.score
        ? this.opts.score(input.trials)
        : {
            trials: input.trials.length,
            done: input.trials.filter((t) => t.state === "done").length,
          },
    );
  }
}
