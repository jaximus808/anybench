// TDM-164 [15.3a]: the outreach scout. For each new lead:
//
//   ingest the repo (packages/kit 4.2) → ProjectDigest + README/manifests
//   → ONE Naïve scout session (packages/naive runSession, output_schema = ScoutOutputSchema)
//   → verifyScoutOutput (quotes checked against the fetched text, 17.4 metrics, honest wording)
//   → status: `scored` (fit >= threshold, verified claims, contact_ok) or `skipped`
//   → for scouted leads with no known email, the injected email finder (if any)
//
// Money: a session starts only when the run cap has a whole per-lead budget left, and gets exactly
// that budget, so a lead's Naïve spend never exceeds OUTREACH_PER_LEAD_BUDGET_MICRO_USD. The run cap
// (OUTREACH_SCOUT_RUN_CAP_MICRO_USD) covers ALL the run's spend: Naïve sessions plus email lookups
// (Hunter via Monid), and a lookup runs only when the cap still covers its max cost. Spend is
// recorded per lead and per kind in integer micro-USD.
//
// Input is a small interface (`ScoutLead`) rather than the leads table, so this runs on any lead
// source; `scoutLeadFromRow` adapts a `leads` row as TDM-163 [15.2a] writes it.

import { createHash } from "node:crypto";
import type { ProjectDigest } from "@anybench/core";
import { SCOUT_ROLE, scoutAgentSpec } from "@anybench/agents";
import type { RepoIngest } from "@anybench/kit";
import {
  ensureAgent,
  NaiveBudgetExceededError,
  NaiveError,
  runSession,
  type NaiveClient,
} from "@anybench/naive";
import { z } from "zod";
import type { MicroUsd } from "./money.js";
import {
  METRICS_BY_CLASS,
  ScoutBriefRejectedError,
  ScoutBriefSchema,
  ScoutMaterial,
  ScoutOutputSchema,
  scoutOutputJsonSchema,
  verifyScoutOutput,
  type ScoutBrief,
  type ScoutBriefJson,
  type ScoutContact,
  type ScoutSkipReason,
} from "./scout-brief.js";

export * from "./scout-brief.js";

// ---- defaults ---------------------------------------------------------------------------------

/** $0.25 of Naïve spend per lead. Env: OUTREACH_PER_LEAD_BUDGET_MICRO_USD. */
export const DEFAULT_SCOUT_PER_LEAD_BUDGET_MICRO_USD: MicroUsd = 250_000n;
/** $3 of Naïve spend per scout run. Env: OUTREACH_SCOUT_RUN_CAP_MICRO_USD. */
export const DEFAULT_SCOUT_RUN_CAP_MICRO_USD: MicroUsd = 3_000_000n;
/** Leads under this fit are skipped. Env: OUTREACH_FIT_THRESHOLD. */
export const DEFAULT_OUTREACH_FIT_THRESHOLD = 60;

/** What the scout is shown of the README / each manifest. */
const README_MAX_LINES = 600;
const README_MAX_CHARS = 60_000;
const MANIFEST_MAX = 4;
const MANIFEST_MAX_LINES = 120;
const MANIFEST_MAX_CHARS = 8_000;

// ---- the input interface --------------------------------------------------------------------

export const ScoutLeadClaimSchema = z.object({
  text: z.string().min(1),
  /** Citation, e.g. https://github.com/o/r/blob/main/README.md#L32. */
  url: z.string().min(1),
  line: z.number().int().positive().optional(),
  /** TDM-163 `CitedClaim.from`. */
  from: z.enum(["readme", "search_snippet"]).optional(),
});
export type ScoutLeadClaim = z.infer<typeof ScoutLeadClaimSchema>;

/** The subset of TDM-163's `RepoSignals` the scout reads (all optional). */
export const ScoutLeadSignalsSchema = z
  .object({
    stars: z.number().int().nonnegative(),
    forks: z.number().int().nonnegative().nullable(),
    pushedAt: z.string().nullable(),
    ownerLogin: z.string(),
    ownerType: z.enum(["User", "Organization"]).nullable(),
    homepage: z.string().nullable(),
    domain: z.string().nullable(),
    description: z.string().nullable(),
    language: z.string().nullable(),
    license: z.string().nullable(),
    topics: z.array(z.string()),
    archived: z.boolean(),
    fork: z.boolean(),
  })
  .partial();
export type ScoutLeadSignals = z.infer<typeof ScoutLeadSignalsSchema>;

/**
 * What the scout needs to know about a lead. Field names follow TDM-163's `NewLead`
 * (packages/outreach/src/store.ts): `githubUrl`, `company`, `contact`, `email`, `source`, and
 * `signals` (RepoSignals + `claims` + `provenance`), flattened by `scoutLeadFromStored`.
 */
export const ScoutLeadSchema = z.object({
  id: z.string().min(1),
  githubUrl: z.url({ hostname: /^github\.com$/ }),
  /** `context_dev` | `hackathon_optin` | ad hoc. */
  source: z.string().nullable().default(null),
  company: z.string().nullable().default(null),
  contact: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  /** Claim lines sourcing already found (README lines, search snippets), each with its URL. */
  claims: z.array(ScoutLeadClaimSchema).default([]),
  signals: ScoutLeadSignalsSchema.default({}),
});
export type ScoutLead = z.infer<typeof ScoutLeadSchema>;
export type ScoutLeadInput = z.input<typeof ScoutLeadSchema>;

/** A lead as TDM-163's `LeadStore` holds it (`StoredLead` = `NewLead` + id). */
export interface StoredLeadLike {
  id: string;
  source?: string | null;
  company: string | null;
  contact: string | null;
  email: string | null;
  githubUrl: string | null;
  signals: unknown;
}

/** A `leads` row (apps/server schema, snake_case). */
export interface LeadRow {
  id: string;
  source?: string | null;
  github_url: string | null;
  company: string | null;
  contact: string | null;
  email: string | null;
  signals: unknown;
}

const StoredSignalsSchema = z.looseObject({
  claims: z.array(z.unknown()).optional(),
  provenance: z.looseObject({ claims: z.array(z.unknown()).optional() }).nullish(),
});

/**
 * Adapt a TDM-163 lead. Claims come from `signals.claims`, plus any extra in
 * `signals.provenance.claims` (deduped by url + text). Unknown or malformed fields are ignored,
 * never fatal. Null when the lead has no GitHub repo (e.g. an opt-in with a blank repo).
 */
export function scoutLeadFromStored(lead: StoredLeadLike): ScoutLead | null {
  if (!lead.githubUrl) return null;
  const signals = StoredSignalsSchema.safeParse(lead.signals ?? {});
  const raw: Record<string, unknown> & z.infer<typeof StoredSignalsSchema> = signals.success
    ? signals.data
    : {};
  const seen = new Set<string>();
  const claims = [...(raw.claims ?? []), ...(raw.provenance?.claims ?? [])].flatMap((c) => {
    const p = ScoutLeadClaimSchema.safeParse(c);
    if (!p.success) return [];
    const k = `${p.data.url}\n${p.data.text}`;
    if (seen.has(k)) return [];
    seen.add(k);
    return [p.data];
  });
  const sig: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(ScoutLeadSignalsSchema.shape)) {
    const v = (schema as z.ZodType).safeParse(raw[k]);
    if (v.success && v.data !== undefined) sig[k] = v.data;
  }
  const parsed = ScoutLeadSchema.safeParse({
    id: lead.id,
    githubUrl: lead.githubUrl,
    source: lead.source ?? null,
    company: lead.company,
    contact: lead.contact,
    email: lead.email,
    claims,
    signals: sig,
  });
  return parsed.success ? parsed.data : null;
}

/** Adapt a `leads` row. */
export function scoutLeadFromRow(row: LeadRow): ScoutLead | null {
  return scoutLeadFromStored({
    id: row.id,
    source: row.source ?? null,
    githubUrl: row.github_url,
    company: row.company,
    contact: row.contact,
    email: row.email,
    signals: row.signals,
  });
}

/** Whom an email would go to, after the optional lookup. */
export function contactFor(lead: ScoutLead, found: string | null): ScoutContact {
  if (lead.email)
    return { status: "email_known", reason: `address from ${lead.source ?? "the lead"}` };
  if (found) return { status: "email_found", reason: "address from the email lookup" };
  // TDM-163 sets `contact` to the org login for organizations, so that is not a person.
  if (lead.signals.ownerType === "Organization") {
    return {
      status: "none",
      reason: "GitHub organization with no person; a human must pick a contact",
    };
  }
  return { status: "none", reason: "no email known or found; a human must pick a contact" };
}

// ---- store ------------------------------------------------------------------------------------

export interface ScoutUpdate {
  status: "scored" | "skipped";
  fit: number;
  brief: ScoutBriefJson;
  /** Set only when the email finder found one and the lead had none. */
  email: string | null;
}

export interface ScoutLeadStore {
  /** Leads with status `new` and a repo, oldest first (or exactly `ids`, when given). */
  listNew(opts: { limit: number; ids?: string[] }): Promise<ScoutLead[]>;
  /** Writes fit/status/brief (and email if found). Only a lead still `new` is updated. */
  saveScout(id: string, update: ScoutUpdate): Promise<void>;
}

/** Any `pg`-style client. */
export interface ScoutQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class PgScoutLeadStore implements ScoutLeadStore {
  constructor(private readonly db: ScoutQueryable) {}

  async listNew(opts: { limit: number; ids?: string[] }): Promise<ScoutLead[]> {
    const ids = opts.ids?.length ? opts.ids : null;
    const r = await this.db.query(
      `select id, source, github_url, company, contact, email, signals from leads
       where status = 'new' and github_url is not null and ($2::uuid[] is null or id = any($2::uuid[]))
       order by created_at asc limit $1`,
      [opts.limit, ids],
    );
    return r.rows.flatMap((row) => {
      const lead = scoutLeadFromRow({
        id: String(row.id),
        source: str(row.source),
        github_url: str(row.github_url),
        company: str(row.company),
        contact: str(row.contact),
        email: str(row.email),
        signals: row.signals,
      });
      return lead ? [lead] : [];
    });
  }

  async saveScout(id: string, u: ScoutUpdate): Promise<void> {
    await this.db.query(
      `update leads set status = $2, fit = $3, brief = $4::jsonb,
         email = coalesce(email, $5), updated_at = now()
       where id = $1 and status = 'new'`,
      [id, u.status, u.fit, JSON.stringify(u.brief), u.email?.toLowerCase() ?? null],
    );
  }
}

export class MemoryScoutLeadStore implements ScoutLeadStore {
  readonly leads: Array<
    ScoutLead & { status: string; fit: number | null; brief: ScoutBriefJson | null }
  >;
  constructor(leads: ScoutLeadInput[] = []) {
    this.leads = leads.map((l) => ({
      ...ScoutLeadSchema.parse(l),
      status: "new",
      fit: null,
      brief: null,
    }));
  }
  async listNew(opts: { limit: number; ids?: string[] }): Promise<ScoutLead[]> {
    return this.leads
      .filter((l) => l.status === "new" && (!opts.ids?.length || opts.ids.includes(l.id)))
      .slice(0, opts.limit);
  }
  async saveScout(id: string, u: ScoutUpdate): Promise<void> {
    const l = this.leads.find((x) => x.id === id && x.status === "new");
    if (!l) return;
    l.status = u.status;
    l.fit = u.fit;
    l.brief = u.brief;
    if (!l.email && u.email) l.email = u.email.toLowerCase();
  }
}

// ---- email finder (people-enrich / Hunter; wired by the caller) ------------------------------

export interface ScoutEmailFinder {
  /** Shown in the brief, e.g. `hunter_via_monid`, `context_dev_people_enrich`. */
  readonly source: string;
  /**
   * The most one lookup can charge. A lookup runs only when the run cap still has this much left
   * after the lead's Naïve session, and a lookup that throws is booked at this amount.
   */
  readonly maxCostMicroUsd: MicroUsd;
  /** Null when no address was found. `costMicroUsd` counts against the scout run cap. */
  find(lead: ScoutLead): Promise<{ email: string | null; costMicroUsd: MicroUsd }>;
}

// ---- the run ----------------------------------------------------------------------------------

export interface ScoutOptions {
  naive: NaiveClient;
  /** Leads come from here and results are written back. Omit with `leads` for a dry run. */
  store?: ScoutLeadStore;
  /** Explicit leads (no store read). With `store`, results are still saved to it. */
  leads?: ScoutLeadInput[];
  /** Default 10. */
  limit?: number;
  /** Only these lead ids (store mode). */
  ids?: string[];
  /** Repo → digest + material. Defaults to `ingestGitHubRepo` from @anybench/kit. */
  ingest?: (githubUrl: string) => Promise<RepoIngest>;
  emailFinder?: ScoutEmailFinder;
  fitThreshold?: number;
  perLeadBudgetMicroUsd?: MicroUsd;
  runCapMicroUsd?: MicroUsd;
  /** Override the model in packages/agents/scout/config.json. */
  model?: string;
  /** Write nothing to the store (sessions still run and spend). */
  dryRun?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export type ScoutLeadResult =
  | {
      leadId: string;
      githubUrl: string;
      status: "scored" | "skipped";
      fit: number;
      skipReason: ScoutSkipReason | null;
      /** Naïve spend for this lead. */
      costMicroUsd: MicroUsd;
      /** Email-lookup spend for this lead (0 when none ran). */
      emailCostMicroUsd: MicroUsd;
      brief: ScoutBrief;
    }
  | {
      leadId: string;
      githubUrl: string;
      status: "error";
      error: { code: string; message: string };
      /** Naïve spend for this lead (the session's, or its whole budget when it can't be read). */
      costMicroUsd: MicroUsd;
    };

export interface ScoutRunReport {
  agent: { id: string; version: number; model: string; action: string };
  results: ScoutLeadResult[];
  /** Everything this run spent: Naïve + email lookups. Never above `runCapMicroUsd`. */
  spentMicroUsd: MicroUsd;
  naiveSpentMicroUsd: MicroUsd;
  emailSpentMicroUsd: MicroUsd;
  perLeadBudgetMicroUsd: MicroUsd;
  runCapMicroUsd: MicroUsd;
  fitThreshold: number;
  /** Set when leads were left because the run cap could not fund another session. */
  stoppedBy: "run_cap" | null;
  unscouted: string[];
}

export const ScoutEnvSchema = z.object({
  OUTREACH_FIT_THRESHOLD: z.coerce.number().int().min(0).max(100).optional(),
  OUTREACH_PER_LEAD_BUDGET_MICRO_USD: z
    .string()
    .regex(/^\d+$/)
    .transform((s) => BigInt(s))
    .optional(),
  OUTREACH_SCOUT_RUN_CAP_MICRO_USD: z
    .string()
    .regex(/^\d+$/)
    .transform((s) => BigInt(s))
    .optional(),
});

/** Threshold and budgets from env, falling back to the defaults. Empty strings count as unset. */
export function scoutSettingsFromEnv(env: Record<string, string | undefined>): {
  fitThreshold: number;
  perLeadBudgetMicroUsd: MicroUsd;
  runCapMicroUsd: MicroUsd;
} {
  const pick = (k: string) => (env[k] ? env[k] : undefined);
  const e = ScoutEnvSchema.parse({
    OUTREACH_FIT_THRESHOLD: pick("OUTREACH_FIT_THRESHOLD"),
    OUTREACH_PER_LEAD_BUDGET_MICRO_USD: pick("OUTREACH_PER_LEAD_BUDGET_MICRO_USD"),
    OUTREACH_SCOUT_RUN_CAP_MICRO_USD: pick("OUTREACH_SCOUT_RUN_CAP_MICRO_USD"),
  });
  return {
    fitThreshold: e.OUTREACH_FIT_THRESHOLD ?? DEFAULT_OUTREACH_FIT_THRESHOLD,
    perLeadBudgetMicroUsd:
      e.OUTREACH_PER_LEAD_BUDGET_MICRO_USD ?? DEFAULT_SCOUT_PER_LEAD_BUDGET_MICRO_USD,
    runCapMicroUsd: e.OUTREACH_SCOUT_RUN_CAP_MICRO_USD ?? DEFAULT_SCOUT_RUN_CAP_MICRO_USD,
  };
}

/** The ingested files the scout may quote: the README and the build manifests. */
export function materialFromIngest(ingest: RepoIngest): ScoutMaterial {
  const files = [];
  if (ingest.context.readme) {
    files.push({ path: ingest.context.readme.path, text: ingest.context.readme.text });
  }
  for (const mf of ingest.context.manifests.slice(0, MANIFEST_MAX)) {
    files.push({ path: mf.path, text: mf.text });
  }
  const src = ingest.digest.source;
  if (src.kind !== "github") throw new Error("scout needs a GitHub digest");
  return new ScoutMaterial(files, src.url, src.commit ?? src.ref);
}

function compactDigest(d: ProjectDigest): Record<string, unknown> {
  return {
    name: d.name,
    kind: d.kind,
    summary: d.summary,
    languages: d.languages.slice(0, 6),
    entrypoints: d.entrypoints.slice(0, 10),
    build_commands: d.build_commands.slice(0, 6),
    test_commands: d.test_commands.slice(0, 6),
    docs: d.docs.slice(0, 10),
    claude_code: d.claude_code,
    releases: { latest: d.releases.latest, tags: d.releases.tags.slice(0, 5) },
    files: d.files,
    suggested_driver_types: d.suggested_driver_types,
  };
}

/** The session's task message (JSON). No email or contact name: the scout doesn't need them. */
export function scoutSessionInput(lead: ScoutLead, ingest: RepoIngest, material: ScoutMaterial) {
  const files = [];
  const readmePath = ingest.context.readme?.path;
  for (const path of material.paths()) {
    const isReadme = path === readmePath;
    const n = material.numbered(
      path,
      isReadme ? README_MAX_LINES : MANIFEST_MAX_LINES,
      isReadme ? README_MAX_CHARS : MANIFEST_MAX_CHARS,
    );
    files.push({ path, lines: n.text, truncated: n.truncated });
  }
  const metrics = Object.fromEntries(
    Object.entries(METRICS_BY_CLASS).map(([k, c]) => [
      k,
      {
        required_core: c.required.map((d) => `${d.id}: ${d.label}`),
        optional: c.optional.map((d) => `${d.id}: ${d.label}`),
        never_a_headline: c.never,
      },
    ]),
  );
  return {
    task: "Write the claim brief for this lead. Answer with the JSON document only.",
    lead: {
      repo_url: lead.githubUrl,
      company: lead.company,
      github: lead.signals,
      cited_claim_lines: lead.claims.slice(0, 12),
    },
    digest: compactDigest(ingest.digest),
    tests: { files: ingest.context.tests.files, dirs: ingest.context.tests.dirs.slice(0, 5) },
    benchmarks: {
      files: ingest.context.benchmarks.files,
      dirs: ingest.context.benchmarks.dirs.slice(0, 5),
      sample: ingest.context.benchmarks.sample.slice(0, 10),
    },
    material: { files },
    metrics,
  };
}

function keyFor(
  lead: ScoutLead,
  fingerprint: string,
  digestHash: string,
  budget: MicroUsd,
): string {
  const h = createHash("sha256")
    .update(`${lead.id}\n${fingerprint}\n${digestHash}\n${budget}`)
    .digest("hex")
    .slice(0, 32);
  return `scout:${lead.id.slice(0, 64)}:${h}`;
}

async function spentBySession(
  naive: NaiveClient,
  sessionId: string | undefined,
): Promise<MicroUsd | null> {
  if (!sessionId) return null;
  try {
    return (await naive.sessions.get(sessionId)).consumedMicroUsd;
  } catch {
    return null;
  }
}

async function defaultIngest(githubUrl: string): Promise<RepoIngest> {
  const { ingestGitHubRepo } = await import("@anybench/kit");
  return ingestGitHubRepo(githubUrl, { depth: 50 });
}

export async function runScout(o: ScoutOptions): Promise<ScoutRunReport> {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  const fitThreshold = o.fitThreshold ?? DEFAULT_OUTREACH_FIT_THRESHOLD;
  const perLead = o.perLeadBudgetMicroUsd ?? DEFAULT_SCOUT_PER_LEAD_BUDGET_MICRO_USD;
  const runCap = o.runCapMicroUsd ?? DEFAULT_SCOUT_RUN_CAP_MICRO_USD;
  if (perLead <= 0n) throw new RangeError("per-lead budget must be > 0 micro-USD");
  if (runCap < perLead) throw new RangeError("run cap must be >= the per-lead budget");
  if (!Number.isInteger(fitThreshold) || fitThreshold < 0 || fitThreshold > 100) {
    throw new RangeError("fit threshold must be an integer 0..100");
  }
  const ingest = o.ingest ?? defaultIngest;
  const limit = o.limit ?? 10;

  const leads: ScoutLead[] = o.leads
    ? o.leads.map((l) => ScoutLeadSchema.parse(l)).slice(0, limit)
    : o.store
      ? await o.store.listNew({ limit, ...(o.ids ? { ids: o.ids } : {}) })
      : [];

  const spec = scoutAgentSpec({
    ...(o.model ? { model: o.model } : {}),
    maxTaskMicroUsd: perLead,
    outputSchema: scoutOutputJsonSchema(),
  });
  const ensured = await ensureAgent(o.naive, spec);
  const report: ScoutRunReport = {
    agent: {
      id: ensured.agent.id,
      version: ensured.agent.version,
      model: ensured.agent.model,
      action: ensured.action,
    },
    results: [],
    spentMicroUsd: 0n,
    naiveSpentMicroUsd: 0n,
    emailSpentMicroUsd: 0n,
    perLeadBudgetMicroUsd: perLead,
    runCapMicroUsd: runCap,
    fitThreshold,
    stoppedBy: null,
    unscouted: [],
  };

  for (const [i, lead] of leads.entries()) {
    const left = runCap - report.spentMicroUsd;
    if (left < perLead) {
      report.stoppedBy = "run_cap";
      report.unscouted = leads.slice(i).map((l) => l.id);
      log(
        `run cap reached (${report.spentMicroUsd} of ${runCap} micro-USD); ${leads.length - i} left`,
      );
      break;
    }
    const fail = (code: string, message: string, cost: MicroUsd): void => {
      report.spentMicroUsd += cost;
      report.naiveSpentMicroUsd += cost;
      report.results.push({
        leadId: lead.id,
        githubUrl: lead.githubUrl,
        status: "error",
        error: { code, message },
        costMicroUsd: cost,
      });
      log(`lead ${lead.id} ${lead.githubUrl}: ${code}: ${message}`);
    };

    let ingested: RepoIngest;
    let material: ScoutMaterial;
    try {
      ingested = await ingest(lead.githubUrl);
      material = materialFromIngest(ingested);
    } catch (err) {
      fail("ingest_failed", (err as Error).message, 0n);
      continue;
    }
    if (!ingested.context.readme) {
      fail("no_readme", "the repo has no README to cite", 0n);
      continue;
    }

    let sessionId: string | undefined;
    let result;
    try {
      result = await runSession(o.naive, {
        agentId: ensured.agent.id,
        agentVersion: ensured.agent.version,
        role: SCOUT_ROLE,
        input: scoutSessionInput(lead, ingested, material),
        output: { schema: ScoutOutputSchema, jsonSchema: scoutOutputJsonSchema() },
        budgetMicroUsd: perLead,
        idempotencyKey: keyFor(lead, ensured.fingerprint, ingested.digest.hash, perLead),
        metadata: { lead_id: lead.id, repo_url: lead.githubUrl },
        onSession: (s) => {
          sessionId = s.id;
        },
      });
    } catch (err) {
      const sid = sessionId ?? (err instanceof NaiveError ? err.sessionId : undefined);
      if (err instanceof NaiveBudgetExceededError && err.consumedMicroUsd === null && !sid) {
        // Refused at create: the pre-flight quote (input + the model's max output) is above the
        // per-lead budget. Nothing ran, nothing is debited (docs/findings/outreach-scout.md).
        fail("budget_below_quote", err.message, 0n);
      } else if (err instanceof NaiveBudgetExceededError) {
        fail(
          "budget_exceeded",
          err.message,
          err.consumedMicroUsd ?? (await spentBySession(o.naive, sid)) ?? perLead,
        );
      } else if (err instanceof NaiveError) {
        // Unknown spend counts as the whole per-lead budget, so the run cap stays conservative.
        fail(err.code, err.message, (await spentBySession(o.naive, sid)) ?? perLead);
      } else {
        throw err;
      }
      continue;
    }
    if (result.status !== "completed") {
      fail("awaiting_human", "scout session parked on a question", result.costMicroUsd);
      continue;
    }

    let verified;
    try {
      verified = verifyScoutOutput(result.output, material);
    } catch (err) {
      if (err instanceof ScoutBriefRejectedError) {
        fail(err.code, err.message, result.costMicroUsd);
        continue;
      }
      throw err;
    }

    const skipReason: ScoutSkipReason | null =
      verified.fit < fitThreshold
        ? "below_threshold"
        : verified.claims.length === 0
          ? "no_verified_claims"
          : !verified.contact_ok
            ? "contact_not_ok"
            : null;
    const status = skipReason ? "skipped" : "scored";

    report.spentMicroUsd += result.costMicroUsd;
    report.naiveSpentMicroUsd += result.costMicroUsd;

    let contactLookup: ScoutBrief["contact_lookup"] = null;
    let foundEmail: string | null = null;
    let emailCost: MicroUsd = 0n;
    if (status === "scored" && !lead.email && o.emailFinder) {
      const finder = o.emailFinder;
      if (runCap - report.spentMicroUsd < finder.maxCostMicroUsd) {
        contactLookup = {
          source: finder.source,
          found: false,
          outcome: "skipped_run_cap",
          cost_micro_usd: 0n,
        };
        log(`lead ${lead.id}: email lookup skipped, the run cap can't cover its max cost`);
      } else {
        let outcome: "found" | "not_found" | "error";
        try {
          const found = await finder.find(lead);
          foundEmail = found.email;
          emailCost = found.costMicroUsd;
          outcome = found.email !== null ? "found" : "not_found";
        } catch (e) {
          // Unknown charge: book the lookup's max so the run cap stays conservative.
          emailCost = finder.maxCostMicroUsd;
          outcome = "error";
          log(`lead ${lead.id}: email lookup failed: ${(e as Error).message}`);
        }
        report.spentMicroUsd += emailCost;
        report.emailSpentMicroUsd += emailCost;
        contactLookup = {
          source: finder.source,
          found: foundEmail !== null,
          outcome,
          cost_micro_usd: emailCost,
        };
      }
    }

    const src = ingested.digest.source;
    const brief = ScoutBriefSchema.parse({
      version: 1,
      lead_id: lead.id,
      repo_url: lead.githubUrl,
      commit: src.kind === "github" ? (src.commit ?? null) : null,
      ...verified,
      fit_threshold: fitThreshold,
      status,
      skip_reason: skipReason,
      contact: contactFor(lead, foundEmail),
      contact_lookup: contactLookup,
      naive: {
        session_id: result.sessionId,
        agent_id: ensured.agent.id,
        agent_version: ensured.agent.version,
        model: ensured.agent.model,
        cost_micro_usd: result.costMicroUsd,
        budget_micro_usd: result.budgetMicroUsd,
      },
      created_at: now().toISOString(),
    } satisfies ScoutBrief);

    report.results.push({
      leadId: lead.id,
      githubUrl: lead.githubUrl,
      status,
      fit: verified.fit,
      skipReason,
      costMicroUsd: result.costMicroUsd,
      emailCostMicroUsd: emailCost,
      brief,
    });
    log(
      `lead ${lead.id} ${lead.githubUrl}: ${status}${skipReason ? ` (${skipReason})` : ""} fit ${verified.fit}, ` +
        `${verified.claims.length} verified claims, ${verified.dropped.length} dropped, ${result.costMicroUsd} micro-USD`,
    );

    if (o.store && !o.dryRun) {
      await o.store.saveScout(lead.id, {
        status,
        fit: verified.fit,
        brief: briefToJson(brief),
        email: lead.email ? null : foundEmail,
      });
    }
  }
  return report;
}

/** The brief as jsonb: micro-USD as decimal strings. */
export function briefToJson(brief: ScoutBrief): ScoutBriefJson {
  return JSON.parse(
    JSON.stringify(brief, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ) as ScoutBriefJson;
}
