// run.notify {run_id, state} (run-email): the transactional email to the run's owner when the run
// is delivered ("your benchmark is done"), or needs them, failed, or was cancelled by us.
//
// Enqueued by the orchestrator in the SAME transaction as the state change (OrchestratorStore
// `onStateChange`, wired in jobs/run-advance.ts), job key `run-notify:<run id>:<state>` (not
// `runs:`, which the sweep reads as "an advance is pending"). Exactly once per (run, state): the job
// claims `runs.stage_outputs.notified.<state>` before sending, records the AgentMail message id
// after, and drops the claim if the send throws so the retry can send.
//
// Recipient: only the run owner's email (users.email, GitHub's primary address at sign-in). No
// email → skipped and logged. A user's own cancel is not emailed (they did it).
// Send path: AgentMail through Monid from the anybench inbox (docs/findings/monid-agentmail.md).
// This is not outreach: no review queue, no daily limit, no List-Unsubscribe.
import { ReportSchema, type Report } from "@anybench/core";
import { runFeeDecision } from "@anybench/billing";
import { createAgentMail, createMonidClientFromEnv, type AgentMail } from "@anybench/outreach";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database, DbTx } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { reports } from "../db/schema/reports.js";
import { runs } from "../db/schema/runs.js";
import { trials } from "../db/schema/trials.js";
import { users } from "../db/schema/users.js";
import { graphileJobQueue } from "../lib/job-queue.js";
import { NOTIFY_STATES, renderRunEmail, type NotifyState } from "../lib/run-email.js";
import type { RunState } from "@anybench/core";
import { defineJob } from "./types.js";

export const RUN_NOTIFY_JOB = "run.notify";
export const DEFAULT_NOTIFY_WEB_URL = "https://anybench.vercel.app";
/** One email to one recipient: AgentMail's $0.001, with headroom for a retry. */
const NOTIFY_MONID_CAP_MICRO_USD = 5_000n;

export const RunNotifyPayloadSchema = z.object({
  run_id: z.uuid(),
  state: z.enum(NOTIFY_STATES),
});
export type RunNotifyPayload = z.infer<typeof RunNotifyPayloadSchema>;

export const runNotifyJobKey = (runId: string, state: NotifyState) =>
  `run-notify:${runId}:${state}`;

export const isNotifyState = (s: RunState): s is NotifyState =>
  (NOTIFY_STATES as readonly string[]).includes(s);

// ---- settings ------------------------------------------------------------------------------------

type NotifyConfig = Pick<
  Config,
  | "NOTIFY_EMAIL_ENABLED"
  | "MONID_API_KEY"
  | "MONID_BASE_URL"
  | "NOTIFY_FROM_INBOX"
  | "OUTREACH_FROM_ADDRESS"
  | "PUBLIC_WEB_URL"
  | "COMPANY_POSTAL_ADDRESS"
>;

export interface NotifySettings {
  enabled: boolean;
  /** Why it is off, for the log. */
  off: string | null;
  inbox: string | null;
  webUrl: string;
  postalAddress: string | null;
}

/** NOTIFY_EMAIL_ENABLED=0/1; unset = on when the Monid key and a sending inbox are present. */
export function notifySettings(config: NotifyConfig): NotifySettings {
  const inbox = config.NOTIFY_FROM_INBOX ?? config.OUTREACH_FROM_ADDRESS ?? null;
  const configured = Boolean(config.MONID_API_KEY && inbox);
  const off =
    config.NOTIFY_EMAIL_ENABLED === "0"
      ? "NOTIFY_EMAIL_ENABLED=0"
      : !configured
        ? "MONID_API_KEY or NOTIFY_FROM_INBOX/OUTREACH_FROM_ADDRESS is not set"
        : null;
  return {
    enabled: off === null,
    off,
    inbox,
    webUrl: config.PUBLIC_WEB_URL ?? DEFAULT_NOTIFY_WEB_URL,
    postalAddress: config.COMPANY_POSTAL_ADDRESS ?? null,
  };
}

// ---- mailer port ---------------------------------------------------------------------------------

export interface RunMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}
export interface RunMailer {
  send(mail: RunMail): Promise<{ messageId: string }>;
}

export function agentMailRunMailer(agentMail: AgentMail, inbox: string): RunMailer {
  return {
    async send(mail) {
      const r = await agentMail.send({
        inboxId: inbox,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        labels: ["run-notify"],
      });
      return { messageId: r.messageId };
    },
  };
}

/** The production mailer: AgentMail via Monid, capped at a few sends' worth of Monid credit. */
export function defaultRunMailer(config: NotifyConfig, inbox: string): RunMailer {
  const monid = createMonidClientFromEnv(
    {
      MONID_API_KEY: config.MONID_API_KEY,
      ...(config.MONID_BASE_URL ? { MONID_BASE_URL: config.MONID_BASE_URL } : {}),
    },
    { spendCapMicroUsd: NOTIFY_MONID_CAP_MICRO_USD },
  );
  return agentMailRunMailer(createAgentMail(monid), inbox);
}

// ---- enqueue (orchestrator hook) -----------------------------------------------------------------

export type StateChangeHook = (
  tx: DbTx,
  change: { runId: string; from: RunState; to: RunState },
) => Promise<void>;

/** Enqueue run.notify in the state change's transaction, for the states that send an email. */
export function runNotifyEnqueuer(queue = graphileJobQueue()): StateChangeHook {
  return async (tx, { runId, to }) => {
    if (!isNotifyState(to)) return;
    await queue.add(
      tx,
      RUN_NOTIFY_JOB,
      { run_id: runId, state: to },
      { jobKey: runNotifyJobKey(runId, to), maxAttempts: 5 },
    );
  };
}

// ---- send ----------------------------------------------------------------------------------------

export type NotifyOutcome =
  { kind: "sent"; messageId: string; subject: string } | { kind: "skipped"; reason: string };

export interface NotifyLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface SendRunNotificationDeps {
  db: Database;
  mailer: RunMailer;
  webUrl: string;
  postalAddress: string | null;
  logger?: NotifyLogger;
}

/** `a…@gmail.com`: enough to tell which address in a log, not the address. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}…@${domain}`;
}

async function cancelReason(db: Database, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        eq(events.type, "run.state_changed"),
        sql`${events.payload}->>'to' = 'cancelled'`,
      ),
    )
    .orderBy(desc(events.seq))
    .limit(1);
  const reason = (row?.payload as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? reason : null;
}

/** Send the owner's email for `state`, at most once per (run, state). */
export async function sendRunNotification(
  deps: SendRunNotificationDeps,
  payload: RunNotifyPayload,
): Promise<NotifyOutcome> {
  const { db } = deps;
  const { run_id: runId, state } = payload;
  const skip = (reason: string): NotifyOutcome => {
    deps.logger?.info({ runId, state, reason }, "run.notify skipped");
    return { kind: "skipped", reason };
  };

  const [row] = await db
    .select({ run: runs, email: users.email, login: users.githubLogin })
    .from(runs)
    .innerJoin(users, eq(users.id, runs.ownerId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) return skip("run not found");
  const { run } = row;
  if (run.state !== state) return skip(`run is ${run.state} now, not ${state}`);
  if (state === "cancelled" && run.cancelCause !== "ours")
    return skip("cancelled by the user: no email");
  const email = row.email?.trim();
  if (!email || !z.email().safeParse(email).success) {
    deps.logger?.warn({ runId, state, owner: row.login }, "run.notify: the owner has no email");
    return skip("owner has no email");
  }

  // Claim (run, state) before sending: exactly once even if two jobs race.
  const claimed = await db
    .update(runs)
    .set({
      stageOutputs: sql`jsonb_set(coalesce(${runs.stageOutputs}, '{}'::jsonb), '{notified}',
        coalesce(${runs.stageOutputs}->'notified', '{}'::jsonb)
          || jsonb_build_object(${state}::text, jsonb_build_object('claimed_at', now())))`,
    })
    .where(
      and(
        eq(runs.id, runId),
        sql`not coalesce((${runs.stageOutputs}->'notified') ? ${state}::text, false)`,
      ),
    )
    .returning({ id: runs.id });
  if (claimed.length === 0) return skip("already sent");

  try {
    const [rep] = await db
      .select({ json: reports.json })
      .from(reports)
      .where(eq(reports.runId, runId))
      .limit(1);
    const parsed = rep ? ReportSchema.safeParse(rep.json) : null;
    const report: Report | null = parsed?.success ? parsed.data : null;
    if (rep && !parsed?.success)
      deps.logger?.warn({ runId }, "run.notify: the stored report does not parse; sending without");

    const outputs = (run.stageOutputs ?? {}) as { failure?: { reason?: string } };
    const comped = run.compedBy !== null;
    let reason: string | null = null;
    let nothingBilled = comped;
    if (state === "needs_human") {
      reason = run.pausedReason;
      nothingBilled = true;
    } else if (state === "failed") {
      reason = report?.postmortem?.explanation ?? outputs.failure?.reason ?? null;
      const ts = await db.select({ s: trials.state }).from(trials).where(eq(trials.runId, runId));
      nothingBilled ||= !runFeeDecision(
        "failed",
        ts.map((t) => t.s),
      ).billable;
    } else if (state === "cancelled") {
      reason = await cancelReason(db, runId);
      nothingBilled = true; // cancel_cause `ours` bills nothing (packages/billing ledger)
    }

    const mail = renderRunEmail({
      runId,
      state,
      question: run.question,
      report,
      reason,
      nothingBilled,
      webUrl: deps.webUrl,
      postalAddress: deps.postalAddress,
    });
    const sent = await deps.mailer.send({ to: email, ...mail });
    await db
      .update(runs)
      .set({
        stageOutputs: sql`jsonb_set(${runs.stageOutputs}, ${`{notified,${state}}`}::text[],
          jsonb_build_object('sent_at', now(), 'message_id', ${sent.messageId}::text))`,
      })
      .where(eq(runs.id, runId));
    deps.logger?.info(
      { runId, state, to: maskEmail(email), messageId: sent.messageId },
      "run.notify sent",
    );
    return { kind: "sent", messageId: sent.messageId, subject: mail.subject };
  } catch (err) {
    // Release the claim so graphile's retry can send.
    await db
      .update(runs)
      .set({ stageOutputs: sql`${runs.stageOutputs} #- ${`{notified,${state}}`}::text[]` })
      .where(eq(runs.id, runId));
    throw err;
  }
}

export interface RunNotifyJobOptions {
  mailer?: (config: Config, inbox: string) => RunMailer;
}

export function createRunNotifyJob(options: RunNotifyJobOptions = {}) {
  return defineJob({
    name: RUN_NOTIFY_JOB,
    payload: RunNotifyPayloadSchema,
    async run(payload, ctx) {
      const log = ctx.logger.child({ job: RUN_NOTIFY_JOB });
      const s = notifySettings(ctx.config);
      if (!s.enabled || !s.inbox) {
        log.info({ runId: payload.run_id, state: payload.state, off: s.off }, "run.notify off");
        return;
      }
      const mailer = options.mailer?.(ctx.config, s.inbox) ?? defaultRunMailer(ctx.config, s.inbox);
      await sendRunNotification(
        { db: ctx.db, mailer, webUrl: s.webUrl, postalAddress: s.postalAddress, logger: log },
        payload,
      );
    },
  });
}

export const runNotifyJob = createRunNotifyJob();
