// `anybench outreach scout` (TDM-164 [15.3a]): one Naïve scout session per new lead → a cited
// claim brief, fit score and status (scored | skipped). Nothing here sends email.
//
// Exit codes: 0 ok (some leads may have errored; see the report) · 1 runtime error · 2 usage error.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { formatUsd } from "@anybench/core";
import { createNaiveClientFromEnv, type NaiveClient } from "@anybench/naive";
import {
  PgScoutLeadStore,
  runScout,
  scoutSettingsFromEnv,
  type ScoutLeadInput,
  type ScoutLeadStore,
  type ScoutOptions,
  type ScoutRunReport,
} from "@anybench/outreach";

export const OUTREACH_SCOUT_USAGE = `Usage:
  anybench outreach scout [--limit N] [--lead <id>]... [options]
  anybench outreach scout --repo <github-url> [--repo <url>]... [options]

For each lead with status=new: ingest the repo (ProjectDigest + README), run ONE Naïve scout
session, keep only claims whose quote is on its cited README/manifest line, and store the brief:
fit >= threshold → status=scored, otherwise status=skipped. --repo scouts ad-hoc repos without
reading or writing the database.
  --limit <N>                  leads to scout (default 10)
  --lead <id>                  only this lead (repeatable)
  --repo <url>                 ad-hoc repo instead of DB leads (repeatable; implies --dry-run)
  --threshold <0-100>          default $OUTREACH_FIT_THRESHOLD or 60
  --budget-micro-usd <N>       Naïve spend per lead (default $OUTREACH_PER_LEAD_BUDGET_MICRO_USD or 250000 = $0.25)
  --run-cap-micro-usd <N>      all spend per run, Naïve + email lookups (default $OUTREACH_SCOUT_RUN_CAP_MICRO_USD or 3000000 = $3)
  --model <id>                 override the scout model (packages/agents/scout/config.json)
  --out <file>                 write the full report (briefs included) as JSON
  --database-url <url>         default $DATABASE_URL, else $LOCAL_DATABASE_URL, else the local dev DB
  --dry-run                    write nothing to the database (sessions still run and spend)
  --json                       print the report as JSON
Needs NAIVE_API_KEY.`;

const DEFAULT_LOCAL_DB_URL = "postgres://anybench:anybench@localhost:55432/anybench";

export interface OpenedScoutStore {
  store: ScoutLeadStore;
  close(): Promise<void>;
}

export interface OutreachScoutDeps {
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  naive?: NaiveClient;
  openStore?: (databaseUrl: string) => Promise<OpenedScoutStore>;
  ingest?: ScoutOptions["ingest"];
}

async function openPgStore(databaseUrl: string): Promise<OpenedScoutStore> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  return {
    store: new PgScoutLeadStore({ query: (text, values) => pool.query(text, values) }),
    close: () => pool.end(),
  };
}

const usd = (m: bigint): string => formatUsd(m, { decimals: 4 });

export function scoutReportJson(report: ScoutRunReport): string {
  return JSON.stringify(report, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function intArg(name: string, raw: string | undefined): bigint | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return { error: `${name} must be a non-negative integer, got "${raw}"` };
  return BigInt(raw);
}

function repoLeadId(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(url);
  return m ? `repo:${m[1]}/${m[2]!.replace(/\.git$/, "")}` : `repo:${url}`;
}

export async function runOutreachScout(
  argv: readonly string[],
  deps: OutreachScoutDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        limit: { type: "string" },
        lead: { type: "string", multiple: true },
        repo: { type: "string", multiple: true },
        threshold: { type: "string" },
        "budget-micro-usd": { type: "string" },
        "run-cap-micro-usd": { type: "string" },
        model: { type: "string" },
        out: { type: "string" },
        "database-url": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    err((e as Error).message);
    err(OUTREACH_SCOUT_USAGE);
    return 2;
  }
  const v = parsed.values;
  if (v.help) {
    out(OUTREACH_SCOUT_USAGE);
    return 0;
  }

  let settings;
  try {
    settings = scoutSettingsFromEnv(env);
  } catch (e) {
    err(`bad outreach env: ${(e as Error).message}`);
    return 2;
  }
  const limit = intArg("--limit", v.limit);
  const threshold = intArg("--threshold", v.threshold);
  const budget = intArg("--budget-micro-usd", v["budget-micro-usd"]);
  const runCap = intArg("--run-cap-micro-usd", v["run-cap-micro-usd"]);
  for (const a of [limit, threshold, budget, runCap]) {
    if (a && typeof a === "object") {
      err(a.error);
      return 2;
    }
  }
  const fitThreshold = threshold === undefined ? settings.fitThreshold : Number(threshold);
  if (fitThreshold > 100) {
    err("--threshold must be 0..100");
    return 2;
  }
  const perLead = (budget as bigint | undefined) ?? settings.perLeadBudgetMicroUsd;
  const cap = (runCap as bigint | undefined) ?? settings.runCapMicroUsd;
  if (perLead <= 0n || cap < perLead) {
    err("need 0 < --budget-micro-usd <= --run-cap-micro-usd");
    return 2;
  }

  let naive = deps.naive;
  if (!naive) {
    if (!env.NAIVE_API_KEY) {
      err("NAIVE_API_KEY is not set");
      return 2;
    }
    naive = createNaiveClientFromEnv(env);
  }

  const repos = v.repo ?? [];
  const adHoc: ScoutLeadInput[] = repos.map((url) => ({ id: repoLeadId(url), githubUrl: url }));
  let opened: OpenedScoutStore | undefined;
  try {
    if (adHoc.length === 0) {
      const databaseUrl =
        v["database-url"] ?? env.DATABASE_URL ?? env.LOCAL_DATABASE_URL ?? DEFAULT_LOCAL_DB_URL;
      opened = await (deps.openStore ?? openPgStore)(databaseUrl);
    }
    const report = await runScout({
      naive,
      ...(opened ? { store: opened.store } : { leads: adHoc }),
      limit: limit === undefined ? adHoc.length || 10 : Number(limit),
      ...(v.lead?.length ? { ids: v.lead } : {}),
      ...(deps.ingest ? { ingest: deps.ingest } : {}),
      fitThreshold,
      perLeadBudgetMicroUsd: perLead,
      runCapMicroUsd: cap,
      ...(v.model ? { model: v.model } : {}),
      dryRun: v["dry-run"] || adHoc.length > 0,
      log: v.json ? () => undefined : err,
    });
    if (v.out) await writeFile(v.out, `${scoutReportJson(report)}\n`, "utf8");
    if (v.json) {
      out(scoutReportJson(report));
    } else {
      for (const r of report.results) {
        const detail =
          r.status === "error"
            ? `error ${r.error.code}`
            : `${r.status}${r.skipReason ? ` (${r.skipReason})` : ""} fit ${r.fit} · ${r.brief.claims.length} cited claims`;
        const email =
          r.status !== "error" && r.emailCostMicroUsd > 0n
            ? ` + email ${usd(r.emailCostMicroUsd)}`
            : "";
        out(`${r.leadId}\t${r.githubUrl}\t${detail}\t${usd(r.costMicroUsd)}${email}`);
      }
      out(
        `scout: ${report.results.length} leads, spend ${usd(report.spentMicroUsd)} of ${usd(cap)} cap` +
          ` (Naïve ${usd(report.naiveSpentMicroUsd)}, email lookups ${usd(report.emailSpentMicroUsd)})` +
          ` (per lead ${usd(perLead)}), model ${report.agent.model}` +
          (report.stoppedBy
            ? `, stopped by ${report.stoppedBy} with ${report.unscouted.length} left`
            : ""),
      );
    }
    return 0;
  } catch (e) {
    err(`outreach scout failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await opened?.close();
  }
}
