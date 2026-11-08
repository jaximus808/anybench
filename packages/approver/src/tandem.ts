// The Tandem approver: the small interface the harness driver / Tandem adapter (TDM-41) calls.
//
//   const approver = createTandemApprover({ baseUrl, config, outDir: EVAL_OUT, trialId, contenderId });
//   const { canvasCode } = await approver.prepare();   // export TANDEM_CANVAS_CODE=canvasCode
//   const stop = new AbortController();
//   const loop = approver.run({ signal: stop.signal });  // alongside the harness
//   ... harness runs ...
//   stop.abort(); await loop;
//   approver.summary();                                  // "simulated approvals: N, latency"
//
// The approver sees only the board (titles, bodies, proposer, timestamps). It is configured once
// per run from the kit's human_in_loop, and every contender gets the same config (config_hash).

import { assertReviewerModelDiffers, approverConfigHash, type ApproverConfig } from "./config.js";
import {
  ApprovalLog,
  summarizeApprovals,
  type ApprovalEvent,
  type ApprovalSummary,
} from "./events.js";
import { LeakGuard } from "./leak-guard.js";
import { approveAllReviewer, type ReviewRequest, type Reviewer } from "./reviewer.js";
import { applyAutoPolicy } from "./tandem-auto.js";
import { TandemClient, type FetchLike, type TandemAction } from "./tandem-client.js";
import {
  applyHumanSimPolicy,
  humanApprove,
  humanReject,
  openHumanSession,
  type HumanSession,
} from "./tandem-human-sim.js";
import { applyPeerPolicy, peerApprove, type PeerReviewerIdentity } from "./tandem-peer.js";

export interface TandemApproverOptions {
  /** Local Tandem server, e.g. http://127.0.0.1:7891 (TANDEM_AUTH=none). */
  baseUrl: string;
  config: ApproverConfig;
  /** EVAL_OUT; events go to `<outDir>/approvals.jsonl`. Null keeps them in memory. */
  outDir: string | null;
  trialId?: string;
  contenderId?: string;
  /** Use an existing canvas instead of creating a fresh trial canvas. */
  canvasCode?: string;
  canvasName?: string;
  /** Required for llm-reviewer (e.g. `naiveReviewer`). auto / human-sim use approve-all. */
  reviewer?: Reviewer;
  /** Models under test; llm-reviewer refuses a reviewer on one of them. */
  subjectModels?: string[];
  guard?: LeakGuard;
  fetch?: FetchLike;
  now?: () => Date;
  /** Shared log (e.g. one per trial across Tandem and Naïve responders). */
  log?: ApprovalLog;
}

export interface TandemApprover {
  readonly config: ApproverConfig;
  readonly configHash: string;
  readonly log: ApprovalLog;
  /** Opens the human session, creates the trial canvas and applies the policy. Idempotent. */
  prepare(): Promise<{ canvasCode: string; canvasUrl: string }>;
  /** One pass over the board: decides what is waiting and counts policy approvals. */
  tick(): Promise<ApprovalEvent[]>;
  /** Ticks every `pollMs` (default 1000) until `signal` aborts, then does one last tick. */
  run(opts: {
    signal: AbortSignal;
    pollMs?: number;
    onError?: (e: unknown) => void;
  }): Promise<void>;
  summary(): ApprovalSummary;
}

/** How long a task under a just-approved epic waits for Tandem's async cascade. */
const CASCADE_GRACE_MS = 5000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`bad timestamp from Tandem: ${iso}`);
  return t;
}

export function createTandemApprover(options: TandemApproverOptions): TandemApprover {
  const config = options.config;
  if (config.kind !== "tandem") throw new Error(`config.kind is '${config.kind}', not 'tandem'`);
  assertReviewerModelDiffers(config, options.subjectModels ?? []);
  if (config.policy === "llm-reviewer" && !options.reviewer) {
    throw new Error("llm-reviewer needs a reviewer (naiveReviewer)");
  }
  const configHash = approverConfigHash(config);
  const client = new TandemClient({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const log = options.log ?? new ApprovalLog(options.outDir);
  const guard = options.guard ?? new LeakGuard();
  const now = options.now ?? (() => new Date());
  const reviewer: Reviewer =
    config.policy === "llm-reviewer" ? options.reviewer! : approveAllReviewer("human-sim");

  const cascades = config.policy !== "llm-reviewer";
  let human: HumanSession | null = null;
  let peer: PeerReviewerIdentity | null = null;
  let preparing: Promise<{ canvasCode: string; canvasUrl: string }> | null = null;
  /** When we approved each epic (ms), to time the `policy:epic` cascade. */
  const epicApprovedAt = new Map<string, number>();
  let ticking = false;

  const base = (): Pick<ApprovalEvent, "v" | "simulated" | "kind" | "policy" | "config_hash"> &
    Partial<Pick<ApprovalEvent, "trial_id" | "contender_id">> => ({
    v: 1,
    simulated: true,
    kind: "tandem",
    policy: config.policy,
    config_hash: configHash,
    ...(options.trialId ? { trial_id: options.trialId } : {}),
    ...(options.contenderId ? { contender_id: options.contenderId } : {}),
  });

  const target = (a: TandemAction): ApprovalEvent["target"] => ({
    type: a.type === "epic" ? "epic" : "task",
    id: a.id,
    ...(a.ticketId ? { ticket: a.ticketId } : {}),
    ...(a.payload.title ? { title: a.payload.title.slice(0, 200) } : {}),
  });

  const emit = (e: ApprovalEvent, out: ApprovalEvent[]): void => {
    if (log.record(e)) out.push(e);
  };

  async function prepare(): Promise<{ canvasCode: string; canvasUrl: string }> {
    preparing ??= (async () => {
      human = await openHumanSession(client, {
        ...(options.canvasCode ? { canvasCode: options.canvasCode } : {}),
        canvasName: options.canvasName ?? `anybench ${options.trialId ?? "trial"}`,
      });
      if (config.policy === "auto") await applyAutoPolicy(client, human);
      else if (config.policy === "human-sim") await applyHumanSimPolicy(client, human);
      else {
        peer = await applyPeerPolicy(client, human, {
          name: config.reviewer_name,
          model: config.reviewer_model!,
        });
      }
      return { canvasCode: human.canvasCode, canvasUrl: `${client.baseUrl}/c/${human.canvasCode}` };
    })();
    return preparing;
  }

  function reviewRequest(a: TandemAction, byId: Map<string, TandemAction>): ReviewRequest {
    const epic = a.payload.epicId ? byId.get(a.payload.epicId) : undefined;
    return {
      kind: a.type === "epic" ? "epic" : "task",
      title: a.payload.title ?? "",
      body: a.payload.body ?? "",
      ...(epic ? { context: `${epic.payload.title ?? ""}\n\n${epic.payload.body ?? ""}` } : {}),
    };
  }

  async function decide(
    a: TandemAction,
    byId: Map<string, TandemAction>,
    out: ApprovalEvent[],
  ): Promise<void> {
    const h = human!;
    const key = `${options.trialId ?? h.canvasCode}:${a.id}`;
    const verdict = await reviewer.review(reviewRequest(a, byId), key);
    const reason = guard.check(verdict.reason, "decision reason");
    const decidedAt = now().getTime();
    let stamp: string | undefined;
    if (verdict.decision === "reject") {
      await humanReject(client, h, a.id, reason);
    } else if (a.type === "task" && peer) {
      stamp = (await peerApprove(client, peer, a.id)).approvedBy;
    } else {
      stamp = (await humanApprove(client, h, a.id)).approvedBy;
      if (a.type === "epic") epicApprovedAt.set(a.id, decidedAt);
    }
    emit(
      {
        ...base(),
        decision: verdict.decision,
        target: target(a),
        decided_by: reviewer.decidedBy,
        ...(stamp ? { board_stamp: stamp } : {}),
        requested_at: a.createdAt,
        decided_at: new Date(decidedAt).toISOString(),
        latency_ms: Math.max(0, decidedAt - ms(a.createdAt)),
        reason,
      },
      out,
    );
  }

  /** Counts approvals Tandem made by policy (born `policy:auto`, cascaded `policy:epic`). */
  function countPolicyApproval(a: TandemAction, out: ApprovalEvent[]): void {
    const stamp = a.approvedBy;
    if (!stamp?.startsWith("policy:")) return;
    const created = ms(a.createdAt);
    let decided = created;
    if (stamp === "policy:epic" && a.payload.epicId) {
      const epicAt = epicApprovedAt.get(a.payload.epicId);
      if (epicAt !== undefined) decided = Math.max(created, epicAt);
    }
    emit(
      {
        ...base(),
        decision: "approve",
        target: target(a),
        decided_by: stamp,
        board_stamp: stamp,
        requested_at: a.createdAt,
        decided_at: new Date(decided).toISOString(),
        latency_ms: decided - created,
      },
      out,
    );
  }

  async function tick(): Promise<ApprovalEvent[]> {
    await prepare();
    const out: ApprovalEvent[] = [];
    if (ticking) return out;
    ticking = true;
    try {
      const h = human!;
      const actions = (await client.listActions(h)).filter(
        (a) => a.type === "epic" || a.type === "task",
      );
      const byId = new Map(actions.map((a) => [a.id, a]));
      // Epics first, oldest first: approving an epic can cascade its tasks.
      const ordered = [...actions].sort(
        (x, y) =>
          (x.type === "epic" ? 0 : 1) - (y.type === "epic" ? 0 : 1) ||
          ms(x.createdAt) - ms(y.createdAt),
      );
      for (const a of ordered) {
        if (log.has("tandem", a.id)) continue;
        if (a.state === "proposed") {
          // Only agent proposals wait for the stand-in; anything else is not ours to decide.
          if (!a.authoredBy?.startsWith("agent:")) continue;
          // A task under a still-proposed epic waits for the epic (it may cascade).
          if (a.type === "task" && a.payload.epicId) {
            const epic = byId.get(a.payload.epicId);
            if (epic?.state === "proposed") continue;
            // Under auto / human-sim the epic approval cascades its tasks; give it time to land.
            const epicAt = epicApprovedAt.get(a.payload.epicId);
            if (cascades && epicAt !== undefined && now().getTime() - epicAt < CASCADE_GRACE_MS) {
              continue;
            }
          }
          await decide(a, byId, out);
          // Later tasks in this same pass see the epic's new state.
          const decided = out.at(-1);
          if (decided?.target.id === a.id) {
            byId.set(a.id, {
              ...a,
              state: decided.decision === "reject" ? "rejected" : "approved",
            });
          }
        } else {
          countPolicyApproval(a, out);
        }
      }
      // A human-sim epic approval cascades asynchronously: pick up its stamped tasks now.
      if (out.some((e) => e.target.type === "epic" && e.decision === "approve")) {
        for (const a of await client.listActions(h, { type: "task" })) {
          if (!log.has("tandem", a.id)) countPolicyApproval(a, out);
        }
      }
    } finally {
      ticking = false;
    }
    return out;
  }

  async function run(opts: {
    signal: AbortSignal;
    pollMs?: number;
    onError?: (e: unknown) => void;
  }): Promise<void> {
    const pollMs = opts.pollMs ?? 1000;
    const step = async (): Promise<void> => {
      try {
        await tick();
      } catch (e) {
        if (opts.onError) opts.onError(e);
        else throw e;
      }
    };
    while (!opts.signal.aborted) {
      await step();
      await sleep(pollMs, opts.signal);
    }
    await step();
  }

  return {
    config,
    configHash,
    log,
    prepare,
    tick,
    run,
    summary: () => summarizeApprovals(log.events()),
  };
}
