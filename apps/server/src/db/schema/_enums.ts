// Text enums stored as `text` + CHECK constraint (TDM-11). Values come from plan.md sections 5–10.
// When packages/core grows the zod state machines, they must use exactly these values.

export const RUN_STATES = [
  "intake",
  "understand",
  "research",
  "kit_draft",
  "env_build",
  "proof",
  "awaiting_go",
  "running",
  "scoring",
  "analyzing",
  "delivered",
  "failed",
  "needs_human",
  "paused_budget",
  "cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TRIAL_STATES = [
  "queued",
  "forking",
  "installing",
  "warming",
  "running",
  "collecting",
  "gating",
  "reviewing",
  "done",
  "failed_infra",
  "failed_subject",
  "cancelled",
] as const;
export type TrialState = (typeof TRIAL_STATES)[number];

export const CONTENDER_STATUSES = ["candidate", "kept", "unavailable"] as const;

export const EVENT_SOURCES = [
  "run",
  "trial",
  "agent_session",
  "computer",
  "ledger",
  "alert",
  "billing",
  "publish",
  "system",
] as const;

export const EVENT_SEVERITIES = ["debug", "info", "warn", "error", "critical", "page"] as const;

export const ALERT_SEVERITIES = ["info", "warn", "critical", "page"] as const;
export const ALERT_STATUSES = ["open", "acked", "resolved"] as const;
export const ALERT_SCOPES = ["global", "user", "run", "trial", "computer"] as const;
export const ALERT_CHANNEL_KINDS = ["in_app", "email", "slack", "tandem"] as const;
export const ALERT_DELIVERY_STATUSES = ["pending", "sent", "failed"] as const;

/** runs.cancel_cause (TDM-54): the user cancelled, or we did (kill switch, pause, auto-action). */
export const RUN_CANCEL_CAUSES = ["user", "ours"] as const;
export const KILL_SWITCH_SCOPES = ["global", "run", "user"] as const;

export const COMPUTER_STATUSES = [
  "creating",
  "running",
  "destroying",
  "destroyed",
  "leaked",
  "error",
] as const;

export const PAYMENT_STATUSES = ["none", "ok", "past_due", "blocked"] as const;
/**
 * Cost-plus billing (plan.md section 8, TDM-171): `run_fee` once per billable run, `compute` once per
 * eval computer (Naïve cost + COMPUTE_MARKUP_BPS), `managed_tokens` at cost + markup.
 */
export const USAGE_TYPES = [
  "run_fee",
  "compute",
  "managed_tokens",
  "adjustment",
  "refund",
] as const;
export const CREDIT_GRANT_CATEGORIES = ["promotional", "paid"] as const;
/** `signup` is the automatic once-per-user grant; `admin` needs an interventions row (DB trigger). */
export const CREDIT_GRANT_SOURCES = ["signup", "admin"] as const;
export const COST_SOURCES = ["naive", "vm", "storage", "vercel"] as const;

export const PUBLISH_VISIBILITIES = ["public", "unlisted", "withdrawn"] as const;
export const EMBED_VIEW_KINDS = ["badge", "embed", "page"] as const;

export const OUTREACH_MESSAGE_KINDS = ["initial", "followup", "reply"] as const;
export const OUTREACH_MESSAGE_STATUSES = [
  "draft",
  "approved",
  "sent",
  "bounced",
  "replied",
] as const;
/** TDM-167 [15.8a]: how an inbound reply was classified (`unclear` goes to the founder). */
export const OUTREACH_REPLY_CATEGORIES = [
  "interested",
  "question",
  "not_now",
  "unsubscribe",
  "bounce_or_auto",
  "unclear",
] as const;
export const OUTREACH_REPLY_CLASSIFIERS = ["rules", "model"] as const;

/** TDM-217 [19.1]: where a kit came from (core KIT_ORIGINS). `uploaded` kits may have no run. */
export const KIT_ORIGINS = ["generated", "curated", "uploaded"] as const;
