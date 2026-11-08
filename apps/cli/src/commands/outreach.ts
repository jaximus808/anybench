// `anybench outreach ...` (TDM-163 [15.2a]): lead sourcing and the hackathon opt-in import.
// Sourcing only: nothing here sends email.
//
// Exit codes: 0 ok · 1 runtime error · 2 usage error.
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  OPTIN_SOURCE,
  PgLeadStore,
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

const formatMicroUsd = (m: bigint) => formatUsd(m, { decimals: 4 });

export const OUTREACH_USAGE = `Usage:
  anybench outreach queries
  anybench outreach source --query <saved-query-id> --limit <N> [options]
  anybench outreach import <file.csv> --source hackathon_optin [--dry-run] [--json]

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
github.com URL). Only --source hackathon_optin is accepted.

Common: --database-url <url> (default $DATABASE_URL, else $LOCAL_DATABASE_URL, else the local dev
DB), --dry-run (write nothing), --json.`;

export const DEFAULT_LOCAL_DB_URL = "postgres://anybench:anybench@localhost:55432/anybench";
export const DEFAULT_SOURCING_MONID_CAP_MICRO_USD = 2_000_000n;

export interface OpenedStore {
  store: LeadStore;
  close(): Promise<void>;
}

export interface OutreachDeps {
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  openStore?: (databaseUrl: string) => Promise<OpenedStore>;
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
    v["database-url"] ?? env.DATABASE_URL ?? env.LOCAL_DATABASE_URL ?? DEFAULT_LOCAL_DB_URL;
  const open = deps.openStore ?? openPgStore;

  if (sub === "import") {
    const file = parsed.positionals[0];
    if (!file || parsed.positionals.length > 1) {
      err("outreach import takes exactly one CSV file");
      return 2;
    }
    if (v.source !== OPTIN_SOURCE) {
      err(`outreach import requires --source ${OPTIN_SOURCE}`);
      return 2;
    }
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
        ...(deps.now ? { now: deps.now } : {}),
      });
      if (v.json) out(json(r));
      else {
        out(`imported ${r.imported.length} of ${r.rows} rows (source=${OPTIN_SOURCE})`);
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

  err(`unknown outreach command "${sub}"`);
  err(OUTREACH_USAGE);
  return 2;
}
