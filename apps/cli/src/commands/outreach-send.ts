// `anybench outreach send` and `anybench outreach send-test` (TDM-166 [15.6a]).
//
// send       dry run by default: lists the approved drafts that would go out today. Only
//            `--send` sends, and on a terminal it asks you to type "send" first (`--yes` skips
//            that, only when the founder said so). Agents never pass --send on their own.
// send-test  sends ONE draft to our own inbox (OUTREACH_FROM_ADDRESS) to check how it renders.
//            The recipient is hard-wired; it can't reach a lead.
//
// Exit codes: 0 ok · 1 runtime error · 2 usage error.
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { formatUsd } from "@anybench/core";
import {
  createAgentMail,
  createMonidClientFromEnv,
  DEFAULT_DAILY_SEND_LIMIT,
  PgDraftStore,
  PgSendStore,
  runSend,
  sendSelfTest,
  type AgentMail,
  type DraftStore,
  type SendStore,
} from "@anybench/outreach";
import { outreachDatabaseUrl } from "./outreach-review.js";

export const DEFAULT_OUTREACH_INBOX = "anybench-outreach@agentmail.to";

export const OUTREACH_SEND_USAGE = `Usage:
  anybench outreach send [--limit N]                 dry run: what would be sent today
  anybench outreach send --send [--limit N] [--yes]  SEND the approved drafts (asks you to type "send")
  anybench outreach send-test <id>                   send one draft to our own inbox only

Sends only founder-approved drafts (approved_by set), re-lints each one (postal address from
COMPANY_POSTAL_ADDRESS, unsubscribe line, link, rule 10), skips suppressed addresses, and stops at
OUTREACH_DAILY_SEND_LIMIT per UTC day (default ${DEFAULT_DAILY_SEND_LIMIT}). From OUTREACH_FROM_ADDRESS via
AgentMail through Monid ($0.001 per email), with List-Unsubscribe: <mailto:inbox?subject=unsubscribe>.
Common: --database-url <url> (default $OUTREACH_DATABASE_URL, $DATABASE_URL, $LOCAL_DATABASE_URL,
local dev DB), --json.`;

export interface OutreachSendDeps {
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  agentmail?: AgentMail;
  openDb?: (
    databaseUrl: string,
  ) => Promise<{ send: SendStore; drafts: DraftStore; close(): Promise<void> }>;
  ask?: (question: string) => Promise<string | null>;
}

async function openPgDb(databaseUrl: string) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const q = { query: (text: string, values?: unknown[]) => client.query(text, values) };
  return { send: new PgSendStore(q), drafts: new PgDraftStore(q), close: () => client.end() };
}

async function ttyAsk(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

export async function runOutreachSend(
  command: "send" | "send-test",
  argv: readonly string[],
  deps: OutreachSendDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        send: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        limit: { type: "string" },
        "database-url": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    err((e as Error).message);
    err(OUTREACH_SEND_USAGE);
    return 2;
  }
  const v = parsed.values;
  if (v.help) {
    out(OUTREACH_SEND_USAGE);
    return 0;
  }
  const postal = env.COMPANY_POSTAL_ADDRESS?.trim();
  if (!postal) {
    err("COMPANY_POSTAL_ADDRESS is not set: refusing (CAN-SPAM needs a postal address)");
    return 2;
  }
  const inbox = (env.OUTREACH_FROM_ADDRESS ?? DEFAULT_OUTREACH_INBOX).trim();
  const limitRaw = env.OUTREACH_DAILY_SEND_LIMIT?.trim();
  if (limitRaw && !/^\d+$/.test(limitRaw)) {
    err("OUTREACH_DAILY_SEND_LIMIT must be a non-negative integer");
    return 2;
  }
  const dailyLimit = limitRaw ? Number(limitRaw) : DEFAULT_DAILY_SEND_LIMIT;
  if (v.limit !== undefined && !/^\d+$/.test(v.limit)) {
    err("--limit must be a non-negative integer");
    return 2;
  }
  const limit = v.limit !== undefined ? Number(v.limit) : dailyLimit;
  const needsMail = command === "send-test" || v.send;
  let agentmail = deps.agentmail;
  if (needsMail && !agentmail) {
    if (!env.MONID_API_KEY) {
      err("MONID_API_KEY is not set");
      return 2;
    }
    // Monid's ledger is capped at $0.001 per email we might send, plus one.
    const cap = 1_000n * BigInt((command === "send-test" ? 1 : limit) + 1);
    agentmail = createAgentMail(createMonidClientFromEnv(env, { spendCapMicroUsd: cap }));
  }
  if (command === "send-test" && !parsed.positionals[0]) {
    err("send-test needs a message id");
    return 2;
  }

  const db = await (deps.openDb ?? openPgDb)(outreachDatabaseUrl(v["database-url"], env));
  try {
    if (command === "send-test") {
      const item = await db.drafts.get(parsed.positionals[0]!);
      const r = await sendSelfTest({ agentmail: agentmail!, inbox, item });
      out(
        `self-test sent to ${r.to} (not to the lead), ${formatUsd(r.costMicroUsd, { decimals: 4 })}`,
      );
      return 0;
    }
    if (v.send && !v.yes) {
      const pending = (await db.send.sendable(limit)).length;
      const a = await (deps.ask ?? ttyAsk)(
        `Send up to ${Math.min(pending, limit)} approved email(s) to real people now? Type "send": `,
      );
      if (a === null) {
        err("--send needs a person at a terminal (or --yes, only when the founder said so)");
        return 2;
      }
      if (a !== "send") {
        out("nothing sent");
        return 0;
      }
    }
    const report = await runSend({
      store: db.send,
      ...(agentmail ? { agentmail } : {}),
      inbox,
      postalAddress: postal,
      dailyLimit,
      limit,
      send: v.send,
      log: err,
    });
    if (v.json) out(json(report));
    else {
      for (const r of report.results) {
        out(
          `${r.id.slice(0, 8)}  ${r.outcome.padEnd(15)}  ${r.to.padEnd(28)}  ${r.subject}${r.detail ? `  (${r.detail})` : ""}`,
        );
      }
      if (!report.results.length) out("no approved drafts waiting");
    }
    err(
      `${report.dryRun ? "DRY RUN (nothing sent; add --send to send)" : "sent"}: ` +
        `${report.results.filter((r) => r.outcome === (report.dryRun ? "would_send" : "sent")).length} ` +
        `· sent today before this ${report.sentTodayBefore}/${report.dailyLimit} · spend ${formatUsd(report.spentMicroUsd, { decimals: 4 })}`,
    );
    return report.results.some((r) => r.outcome === "failed_unknown") ? 1 : 0;
  } finally {
    await db.close();
  }
}
