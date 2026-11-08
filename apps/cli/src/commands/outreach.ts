// `anybench outreach ...` (TDM-163 [15.2a]): lead sourcing and the hackathon opt-in import.
// TDM-167 [15.8a]: `poll` (alias `replies`) reads and classifies replies, `stats` prints the funnel.
// Nothing here sends email or answers anyone.
//
// Exit codes: 0 ok · 1 runtime error · 2 usage error.
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  DEFAULT_REPLY_MODEL_CAP_MICRO_USD,
  OPTIN_SOURCE,
  PUBLIC_CONTACT_SOURCE,
  PgFunnel,
  PgLeadStore,
  PgReplyStore,
  createAgentMail,
  formatFunnel,
  pollReplies,
  slackWebhookPoster,
  type AgentMail,
  type FunnelReader,
  type ReplyModelClassifier,
  type ReplyStore,
  SAVED_CLAIM_QUERIES,
  createContextDevClientFromEnv,
  createFileCache,
  createGithubSignals,
  createMonidClientFromEnv,
  importOptinCsv,
  runSourcing,
  type FetchLike,
  type LeadStore,
} from "@anybench/outreach";
import { formatUsd } from "@anybench/core";
import { createNaiveReplyClassifier } from "@anybench/agents";
import { createNaiveClientFromEnv, type NaiveClient } from "@anybench/naive";

const formatMicroUsd = (m: bigint) => formatUsd(m, { decimals: 4 });

export const OUTREACH_USAGE = `Usage:
  anybench outreach queries
  anybench outreach source --query <saved-query-id> --limit <N> [options]
  anybench outreach import <file.csv> --source hackathon_optin|public_contact [--dry-run] [--json]
  anybench outreach poll [--no-model] [--no-slack] [--dry-run] [--json]     (alias: replies)
  anybench outreach stats [--json]

source: run a saved claim query through Context.dev web-search (site:github.com), keep repo roots,
fetch GitHub signals (stars, last push, README claim lines), look up an email with Hunter (via
Monid) only for leads that pass the fit check, dedupe by repo URL, company domain and email, skip
suppressed addresses, and write leads (source=context_dev, status=new).
  --limit <N>                    leads to write
  --credit-cap <N>               Context.dev credits (default $OUTREACH_CONTEXT_DEV_CREDIT_CAP or 300)
  --monid-cap-micro-usd <N>      Monid spend cap (default $OUTREACH_SOURCING_MONID_CAP_MICRO_USD or 2000000 = $2)
  --github-budget <N>            GitHub REST calls (default 40; unauthenticated is 60/h per IP)
  --no-email                     skip Hunter lookups
  --num-results <N>              results per search (default limit x 3, 10..30)
  --cache-dir <dir>              GitHub cache (default ~/.anybench/cache/outreach-github)

import: CSV with a header row and columns name,email,repo (repo may be blank; owner/repo or a
github.com URL). --source hackathon_optin: people who asked to be benchmarked. --source
public_contact: addresses a project publishes for contact (site contact page/footer or a README
contact line; never commits, profiles, LinkedIn or a finder); extra required column
email_source_url (https, where it is published) and optional email_snippet.

poll: read new replies in our AgentMail inbox ($OUTREACH_FROM_ADDRESS, via Monid; reads are free),
classify each (interested, question, not_now, unsubscribe, bounce_or_auto, unclear) by rules, then
the Naïve account manager when the rules are unsure ($NAIVE_API_KEY set, unless --no-model).
Unsubscribes and bounces go on the suppression list at once. Interested, question and unclear
replies are marked for the founder; nothing is ever sent or answered. Interested replies are posted
to $SLACK_WEBHOOK_URL when it is set (unless --no-slack).
  --model-cap-micro-usd <N>      Naïve cap (default $OUTREACH_REPLY_MODEL_CAP_MICRO_USD or 200000 = $0.20)
  --monid-cap-micro-usd <N>      Monid cap (default $OUTREACH_POLL_MONID_CAP_MICRO_USD or 100000 = $0.10)
  --inbox <address>              default $OUTREACH_FROM_ADDRESS or anybench-outreach@agentmail.to

stats: the funnel from the DB (sourced → scouted → fit → drafted → approved → sent → replied →
interested → unsubscribed, distinct leads), suppressions and recorded spend. Counts only.

Common: --database-url <url> (default $OUTREACH_DATABASE_URL, else $DATABASE_URL, else $LOCAL_DATABASE_URL, else the local dev
DB), --dry-run (write nothing), --json.`;

export const DEFAULT_LOCAL_DB_URL = "postgres://anybench:anybench@localhost:55432/anybench";
export const DEFAULT_SOURCING_MONID_CAP_MICRO_USD = 2_000_000n;
export const DEFAULT_POLL_MONID_CAP_MICRO_USD = 100_000n;
export const DEFAULT_OUTREACH_INBOX = "anybench-outreach@agentmail.to";

export interface OpenedStore {
  store: LeadStore;
  close(): Promise<void>;
}

export interface OpenedReplyDb {
  replies: ReplyStore;
  funnel: FunnelReader;
  close(): Promise<void>;
}

export interface OutreachDeps {
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  openStore?: (databaseUrl: string) => Promise<OpenedStore>;
  /** TDM-167: the reply/funnel tables (default: Postgres). */
  openReplyDb?: (databaseUrl: string) => Promise<OpenedReplyDb>;
  /** TDM-167: AgentMail (default: through Monid from $MONID_API_KEY). */
  agentmail?: AgentMail;
  /** TDM-167: Naïve for the classifier fallback (default: from $NAIVE_API_KEY). */
  naive?: NaiveClient;
  fetch?: FetchLike;
  now?: () => number;
}

async function openPgStore(databaseUrl: string): Promise<OpenedStore> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  return {
    store: new PgLeadStore({ query: (text, values) => pool.query(text, values) }),
    close: () => pool.end(),
  };
}

async function openPgReplyDb(databaseUrl: string): Promise<OpenedReplyDb> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const q = { query: (text: string, values?: unknown[]) => pool.query(text, values) };
  return { replies: new PgReplyStore(q), funnel: new PgFunnel(q), close: () => pool.end() };
}

/** postgres://user:pass@host:port/db → host:port/db (never print credentials). */
export function describeDbUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparseable database url)";
  }
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

function positiveInt(
  name: string,
  raw: string | undefined,
): number | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return { error: `${name} must be a non-negative integer, got "${raw}"` };
  return Number(raw);
}

export async function runOutreach(
  argv: readonly string[],
  deps: OutreachDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const [sub, ...rest] = argv;

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        query: { type: "string" },
        limit: { type: "string" },
        source: { type: "string" },
        "credit-cap": { type: "string" },
        "monid-cap-micro-usd": { type: "string" },
        "github-budget": { type: "string" },
        "num-results": { type: "string" },
        "no-email": { type: "boolean", default: false },
        "cache-dir": { type: "string" },
        "database-url": { type: "string" },
        "model-cap-micro-usd": { type: "string" },
        "no-model": { type: "boolean", default: false },
        "no-slack": { type: "boolean", default: false },
        inbox: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    err((e as Error).message);
    err(OUTREACH_USAGE);
    return 2;
  }
  const v = parsed.values;
  if (v.help || sub === undefined) {
    (v.help ? out : err)(OUTREACH_USAGE);
    return v.help ? 0 : 2;
  }

  if (sub === "queries") {
    for (const q of SAVED_CLAIM_QUERIES) out(`${q.id}\t${q.description}`);
    return 0;
  }

  const databaseUrl =
    v["database-url"] ??
    env.OUTREACH_DATABASE_URL ??
    env.DATABASE_URL ??
    env.LOCAL_DATABASE_URL ??
    DEFAULT_LOCAL_DB_URL;
  const open = deps.openStore ?? openPgStore;

  if (sub === "import") {
    const file = parsed.positionals[0];
    if (!file || parsed.positionals.length > 1) {
      err("outreach import takes exactly one CSV file");
      return 2;
    }
    if (v.source !== OPTIN_SOURCE && v.source !== PUBLIC_CONTACT_SOURCE) {
      err(`outreach import requires --source ${OPTIN_SOURCE} or ${PUBLIC_CONTACT_SOURCE}`);
      return 2;
    }
    const source = v.source;
    let csv: string;
    try {
      csv = await readFile(file, "utf8");
    } catch (e) {
      err(`cannot read ${file}: ${(e as Error).message}`);
      return 1;
    }
    const db = await open(databaseUrl);
    try {
      if (!v.json)
        err(`leads db: ${describeDbUrl(databaseUrl)}${v["dry-run"] ? " (dry run)" : ""}`);
      const r = await importOptinCsv({
        csv,
        file: basename(file),
        store: db.store,
        dryRun: v["dry-run"],
        source,
        ...(deps.now ? { now: deps.now } : {}),
      });
      if (v.json) out(json(r));
      else {
        out(`imported ${r.imported.length} of ${r.rows} rows (source=${source})`);
        for (const s of r.skipped)
          out(`  row ${s.row}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`);
      }
      return 0;
    } catch (e) {
      err(`outreach import: ${(e as Error).message}`);
      return 1;
    } finally {
      await db.close();
    }
  }

  if (sub === "source") {
    if (!v.query) {
      err("outreach source requires --query <saved-query-id> (see `anybench outreach queries`)");
      return 2;
    }
    const limit = positiveInt("--limit", v.limit);
    const creditCap = positiveInt("--credit-cap", v["credit-cap"]);
    const githubBudget = positiveInt("--github-budget", v["github-budget"]);
    const numResults = positiveInt("--num-results", v["num-results"]);
    for (const x of [limit, creditCap, githubBudget, numResults]) {
      if (typeof x === "object") {
        err(x.error);
        return 2;
      }
    }
    if (typeof limit !== "number" || limit < 1) {
      err("outreach source requires --limit <N> (N >= 1)");
      return 2;
    }
    const capRaw = v["monid-cap-micro-usd"] ?? env.OUTREACH_SOURCING_MONID_CAP_MICRO_USD?.trim();
    if (capRaw !== undefined && capRaw !== "" && !/^\d+$/.test(capRaw)) {
      err(`Monid cap must be integer micro-USD, got "${capRaw}"`);
      return 2;
    }
    const monidCap = capRaw ? BigInt(capRaw) : DEFAULT_SOURCING_MONID_CAP_MICRO_USD;

    if (!env.CONTEXT_DEV_API_KEY?.trim()) {
      err("CONTEXT_DEV_API_KEY is not set");
      return 1;
    }
    const fetchOpt = deps.fetch ? { fetch: deps.fetch } : {};
    const contextDev = createContextDevClientFromEnv(env, {
      ...(typeof creditCap === "number" ? { creditCap } : {}),
      ...fetchOpt,
    });
    const monid = env.MONID_API_KEY?.trim()
      ? createMonidClientFromEnv(env, { spendCapMicroUsd: monidCap, ...fetchOpt })
      : undefined;
    if (!monid && !v.json) err("MONID_API_KEY is not set: no email lookups, no GitHub fallback");
    const github = createGithubSignals({
      token: env.GITHUB_TOKEN?.trim() || undefined,
      requestBudget: typeof githubBudget === "number" ? githubBudget : 40,
      cache: createFileCache(
        v["cache-dir"] ?? join(homedir(), ".anybench", "cache", "outreach-github"),
      ),
      ...(monid ? { monid } : {}),
      ...fetchOpt,
      ...(deps.now ? { now: deps.now } : {}),
    });

    const db = await open(databaseUrl);
    try {
      if (!v.json) {
        err(
          `leads db: ${describeDbUrl(databaseUrl)}${v["dry-run"] ? " (dry run)" : ""} · caps: ` +
            `${contextDev.creditCap} Context.dev credits, ${formatMicroUsd(monidCap)} Monid`,
        );
      }
      const r = await runSourcing({
        queryId: v.query,
        limit,
        contextDev,
        github,
        monid,
        store: db.store,
        findEmails: !v["no-email"] && monid !== undefined,
        dryRun: v["dry-run"],
        ...(typeof numResults === "number" ? { numResults } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(v.json ? {} : { log: (l: string) => err(`  ${l}`) }),
      });
      if (v.json) out(json(r));
      else {
        out(
          `wrote ${r.written.length} leads (${r.written.filter((w) => w.email).length} with email), ` +
            `skipped ${r.skipped.length}, stopped by ${r.stoppedBy}`,
        );
        out(
          `spent: ${r.contextDevCredits} Context.dev credits, ${r.githubRequests} GitHub calls` +
            `${r.githubExhausted ? " (exhausted)" : ""}, ${formatMicroUsd(r.monidSpentMicroUsd)} Monid ` +
            `(${r.emailLookups} Hunter lookups, ${r.emailsFound} found)`,
        );
        for (const w of r.written) out(`  ${w.githubUrl}${w.email ? ` <${w.email}>` : ""}`);
      }
      return 0;
    } catch (e) {
      err(`outreach source: ${(e as Error).message}`);
      return 1;
    } finally {
      await db.close();
    }
  }

  if (sub === "stats") {
    const db = await (deps.openReplyDb ?? openPgReplyDb)(databaseUrl);
    try {
      const f = await db.funnel.funnel();
      if (v.json) out(json(f));
      else {
        err(`leads db: ${describeDbUrl(databaseUrl)}`);
        for (const l of formatFunnel(f, formatMicroUsd)) out(l);
      }
      return 0;
    } catch (e) {
      err(`outreach stats: ${(e as Error).message}`);
      return 1;
    } finally {
      await db.close();
    }
  }

  if (sub === "poll" || sub === "replies") {
    const microArg = (name: string, raw: string | undefined, dflt: bigint): bigint | string => {
      const t = raw?.trim();
      if (t === undefined || t === "") return dflt;
      return /^\d+$/.test(t) ? BigInt(t) : `${name} must be integer micro-USD, got "${t}"`;
    };
    const monidCap = microArg(
      "Monid cap",
      v["monid-cap-micro-usd"] ?? env.OUTREACH_POLL_MONID_CAP_MICRO_USD,
      DEFAULT_POLL_MONID_CAP_MICRO_USD,
    );
    const modelCap = microArg(
      "Naïve cap",
      v["model-cap-micro-usd"] ?? env.OUTREACH_REPLY_MODEL_CAP_MICRO_USD,
      DEFAULT_REPLY_MODEL_CAP_MICRO_USD,
    );
    for (const x of [monidCap, modelCap]) {
      if (typeof x === "string") {
        err(x);
        return 2;
      }
    }
    const inbox = v.inbox ?? (env.OUTREACH_FROM_ADDRESS?.trim() || DEFAULT_OUTREACH_INBOX);
    const monid =
      deps.agentmail || !env.MONID_API_KEY?.trim()
        ? undefined
        : createMonidClientFromEnv(env, {
            spendCapMicroUsd: monidCap as bigint,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
          });
    const agentmail = deps.agentmail ?? (monid ? createAgentMail(monid) : undefined);
    if (!agentmail) {
      err("MONID_API_KEY is not set (AgentMail is read through Monid)");
      return 1;
    }
    let model: ReplyModelClassifier | undefined;
    if (!v["no-model"]) {
      const naive =
        deps.naive ?? (env.NAIVE_API_KEY?.trim() ? createNaiveClientFromEnv(env) : undefined);
      if (naive) model = createNaiveReplyClassifier({ naive });
      else if (!v.json) err("NAIVE_API_KEY is not set: rules only (unsure replies → unclear)");
    }
    const slackUrl = env.SLACK_WEBHOOK_URL?.trim();
    const slack =
      slackUrl && !v["no-slack"] && !v["dry-run"]
        ? slackWebhookPoster(slackUrl, deps.fetch ?? fetch)
        : undefined;

    const db = await (deps.openReplyDb ?? openPgReplyDb)(databaseUrl);
    try {
      if (!v.json) {
        err(
          `leads db: ${describeDbUrl(databaseUrl)}${v["dry-run"] ? " (dry run)" : ""} · inbox ${inbox} · ` +
            `caps: ${formatMicroUsd(monidCap as bigint)} Monid, ` +
            `${model ? `${formatMicroUsd(modelCap as bigint)} Naïve` : "no model"}` +
            `${slack ? " · slack on" : ""}`,
        );
      }
      const r = await pollReplies({
        agentmail,
        inbox,
        store: db.replies,
        ...(model ? { model } : {}),
        modelCapMicroUsd: modelCap as bigint,
        ...(slack ? { slack } : {}),
        dryRun: v["dry-run"],
        ...(v.json ? {} : { log: (l: string) => err(`  ${l}`) }),
      });
      const monidSpent = monid?.spentMicroUsd() ?? 0n;
      if (v.json) out(json({ ...r, monidSpentMicroUsd: monidSpent }));
      else {
        const by = (c: string) => r.replies.filter((x) => x.category === c).length;
        out(
          `polled ${r.listed} received messages since ${r.after ?? "the start"}: ${r.inbound} inbound, ` +
            `${r.alreadyKnown} already stored, ${r.replies.length} new${r.truncated ? " (truncated)" : ""}`,
        );
        out(
          `new replies: interested ${by("interested")}, question ${by("question")}, ` +
            `not_now ${by("not_now")}, unsubscribe ${by("unsubscribe")}, ` +
            `bounce_or_auto ${by("bounce_or_auto")}, unclear ${by("unclear")}`,
        );
        const sup = r.replies.filter((x) => x.suppressed);
        out(
          `suppressed ${sup.length}${sup.length ? `: ${sup.map((x) => x.suppressed).join(", ")}` : ""}`,
        );
        const founder = r.replies.filter((x) => x.needsFounder);
        out(`needs founder ${founder.length} (nothing was answered automatically)`);
        for (const x of founder)
          out(`  ${x.receivedAt} ${x.from} [${x.category}] ${x.subject ?? ""}`);
        out(
          `spent: ${formatMicroUsd(r.modelSpentMicroUsd)} Naïve (${r.modelSpentMicroUsd} micro-USD), ` +
            `${formatMicroUsd(monidSpent)} Monid (${monidSpent} micro-USD)` +
            `${r.modelSkipped ? ` · ${r.modelSkipped} left to rules (model cap)` : ""}` +
            `${slack ? ` · slack posted ${r.slackPosted}${r.slackErrors.length ? `, ${r.slackErrors.length} failed` : ""}` : ""}`,
        );
      }
      return 0;
    } catch (e) {
      err(`outreach poll: ${(e as Error).message}`);
      return 1;
    } finally {
      await db.close();
    }
  }

  err(`unknown outreach command "${sub}"`);
  err(OUTREACH_USAGE);
  return 2;
}
