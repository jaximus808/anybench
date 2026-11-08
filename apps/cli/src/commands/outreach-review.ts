// `anybench outreach draft` and `anybench outreach review` (TDM-165 [15.5a]): the writer and the
// founder review queue. Nothing here sends email (sending is `anybench outreach send`, TDM-166).
//
// Approving needs a person: `approve` asks for confirmation on a terminal and refuses without one
// unless `--yes` is given. Agents must never pass `--yes` on their own.
//
// Exit codes: 0 ok · 1 runtime error · 2 usage error.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { formatUsd } from "@anybench/core";
import { createNaiveClientFromEnv, type NaiveClient } from "@anybench/naive";
import {
  DraftNotFoundError,
  lintDraft,
  PgDraftStore,
  runWriter,
  textToHtml,
  type DraftStore,
  type QueueItem,
} from "@anybench/outreach";

export const DEFAULT_LOCAL_DB_URL = "postgres://anybench:anybench@localhost:55432/anybench";

/** The outreach DB: --database-url, else OUTREACH_DATABASE_URL, else DATABASE_URL, else local. */
export function outreachDatabaseUrl(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return (
    flag ??
    env.OUTREACH_DATABASE_URL ??
    env.DATABASE_URL ??
    env.LOCAL_DATABASE_URL ??
    DEFAULT_LOCAL_DB_URL
  );
}

export const OUTREACH_DRAFT_USAGE = `Usage:
  anybench outreach draft [--limit N] [--lead <id>]... [options]

For each scored lead with an address and no draft yet (not suppressed): ONE small Naïve writer
session writes the subject and a personal opening; code checks it (plan 17.2 rule 10, numbers only
from the README claims, no URLs, no other customers) and falls back to a template opening when it
fails. Code adds the fixed pitch, the free offer, the link and the CAN-SPAM footer
(COMPANY_POSTAL_ADDRESS), lints the whole email, and stores it as a draft for review. Never sends.
  --limit <N>                 drafts to write (default 15)
  --lead <id>                 only this lead (repeatable)
  --allow-skipped             also draft leads the scout skipped as below_threshold or
                              no_verified_claims (never contact_not_ok)
  --no-model                  template openings only (no Naïve spend)
  --model <id>                override packages/agents/writer/config.json
  --budget-micro-usd <N>      Naïve spend per draft (default 50000 = $0.05)
  --run-cap-micro-usd <N>     Naïve spend per run (default 500000 = $0.50)
  --sender <name>             sign-off name (default $OUTREACH_SENDER_NAME or Jaxon)
  --database-url <url>        default $OUTREACH_DATABASE_URL, $DATABASE_URL, $LOCAL_DATABASE_URL, local dev DB
  --dry-run                   print the drafts, store nothing (sessions still run)
  --json`;

export const OUTREACH_REVIEW_USAGE = `Usage:
  anybench outreach review                      list drafts and approved-but-unsent messages
  anybench outreach review show <id>            the full email, where the address came from, the cited claims
  anybench outreach review approve <id> [--by <name>] [--note <why>] [--yes]
  anybench outreach review edit <id>            edit subject + body in $EDITOR (back to draft)
  anybench outreach review reject <id> [--by <name>] [--note <why>]
  anybench outreach review walk [--by <name>]   go through every draft: approve / edit / reject / skip

<id> may be the first 8 characters. approve and reject write an interventions row (who, what,
why). approve refuses a draft that fails lint (rule 10, footer, postal address, link) and asks
for confirmation on a terminal; --yes skips the question (only when the founder says so).
--by defaults to $OUTREACH_APPROVER. Approving does not send: see \`anybench outreach send\`.
Common: --database-url <url>, --json.`;

export interface OutreachReviewDeps {
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  naive?: NaiveClient;
  openStore?: (databaseUrl: string) => Promise<{ store: DraftStore; close(): Promise<void> }>;
  /** Answers a yes/no or menu question (default: readline on a TTY, else null). */
  ask?: (question: string) => Promise<string | null>;
  /** Edits a file in place (default: $EDITOR). */
  editFile?: (path: string) => boolean;
}

async function openPgDraftStore(databaseUrl: string) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  return {
    store: new PgDraftStore({ query: (text, values) => pool.query(text, values) }),
    close: () => pool.end(),
  };
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

function editorEdit(path: string): boolean {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const r = spawnSync(editor, [path], { stdio: "inherit", shell: true });
  return r.status === 0;
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

function intArg(name: string, raw: string | undefined): bigint | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return { error: `${name} must be a non-negative integer, got "${raw}"` };
  return BigInt(raw);
}

// ---- draft ------------------------------------------------------------------------------------

export async function runOutreachDraft(
  argv: readonly string[],
  deps: OutreachReviewDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  let v;
  try {
    v = parseArgs({
      args: [...argv],
      options: {
        limit: { type: "string" },
        lead: { type: "string", multiple: true },
        "allow-skipped": { type: "boolean", default: false },
        "no-model": { type: "boolean", default: false },
        model: { type: "string" },
        "budget-micro-usd": { type: "string" },
        "run-cap-micro-usd": { type: "string" },
        sender: { type: "string" },
        "database-url": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }).values;
  } catch (e) {
    err((e as Error).message);
    err(OUTREACH_DRAFT_USAGE);
    return 2;
  }
  if (v.help) {
    out(OUTREACH_DRAFT_USAGE);
    return 0;
  }
  const limit = intArg("--limit", v.limit);
  const budget = intArg("--budget-micro-usd", v["budget-micro-usd"]);
  const cap = intArg("--run-cap-micro-usd", v["run-cap-micro-usd"]);
  for (const a of [limit, budget, cap]) {
    if (a && typeof a === "object") {
      err(a.error);
      return 2;
    }
  }
  const postal = env.COMPANY_POSTAL_ADDRESS?.trim() ?? "";
  if (!postal) {
    err("COMPANY_POSTAL_ADDRESS is not set: every email needs a postal address (CAN-SPAM)");
    return 2;
  }
  let naive = deps.naive;
  if (!v["no-model"] && !naive) {
    if (!env.NAIVE_API_KEY) {
      err("NAIVE_API_KEY is not set (or pass --no-model)");
      return 2;
    }
    naive = createNaiveClientFromEnv(env);
  }

  const opened = await (deps.openStore ?? openPgDraftStore)(
    outreachDatabaseUrl(v["database-url"], env),
  );
  try {
    const leads = await opened.store.draftable({
      limit: Number((limit as bigint | undefined) ?? 15n),
      ...(v.lead?.length ? { ids: v.lead } : {}),
      allowSkipped: v["allow-skipped"],
    });
    if (!leads.length) {
      err("no leads to draft (need a scout brief, an address, no draft yet, not suppressed)");
      return 0;
    }
    const report = await runWriter({
      ...(naive ? { naive } : {}),
      leads,
      postalAddress: postal,
      noModel: v["no-model"],
      senderName: v.sender ?? env.OUTREACH_SENDER_NAME ?? "Jaxon",
      ...(v.model ? { model: v.model } : {}),
      ...(budget !== undefined ? { perLeadBudgetMicroUsd: budget as bigint } : {}),
      ...(cap !== undefined ? { runCapMicroUsd: cap as bigint } : {}),
      log: err,
    });
    const stored: { leadId: string; messageId: string | null }[] = [];
    for (const d of report.drafts) {
      if (d.lint.length) {
        err(`lead ${d.leadId}: not stored, lint failed: ${d.lint.join("; ")}`);
        continue;
      }
      const id = v["dry-run"] ? null : await opened.store.insertDraft(d.leadId, d.draft);
      stored.push({ leadId: d.leadId, messageId: id });
      if (!v.json) {
        out(`\n=== ${id ?? "(dry run)"} → ${d.email} [${d.openingFrom} opening]`);
        out(`Subject: ${d.draft.subject}\n`);
        out(d.draft.text);
      }
    }
    const spend = `Naïve spend ${formatUsd(report.spentMicroUsd, { decimals: 4 })} (${report.spentMicroUsd} micro-USD)`;
    if (v.json) out(json({ ...report, stored }));
    err(
      `draft: ${stored.length} of ${report.drafts.length} stored${v["dry-run"] ? " (dry run)" : ""}, ${spend}. Review: anybench outreach review`,
    );
    return 0;
  } finally {
    await opened.close();
  }
}

// ---- review -----------------------------------------------------------------------------------

function emailSource(item: QueueItem): string {
  const prov = item.signals.provenance as Record<string, unknown> | undefined;
  const e = prov?.email as Record<string, unknown> | undefined;
  if (e && typeof e.url === "string") {
    return `${String(e.source ?? "published")} at ${e.url}${typeof e.snippet === "string" ? ` ("${e.snippet}")` : ""}`;
  }
  return item.source ?? "unknown";
}

function claims(item: QueueItem): string[] {
  const b = item.brief as { claims?: { text?: string; source_url?: string }[] } | null;
  return (b?.claims ?? []).map((c) => `${c.text ?? ""}  (${c.source_url ?? "?"})`);
}

function showItem(item: QueueItem, postal: string | undefined, out: (l: string) => void): void {
  const lint = lintDraft(item, { postalAddress: postal });
  out(`id:       ${item.id}  [${item.status}${item.approvedBy ? ` by ${item.approvedBy}` : ""}]`);
  out(`to:       ${item.email ?? "(none)"}  ·  ${item.company ?? ""} ${item.githubUrl ?? ""}`);
  out(`address:  ${emailSource(item)}`);
  out(`lint:     ${lint.length ? lint.join("; ") : "ok"}`);
  const cs = claims(item);
  if (cs.length) {
    out("claims the email may quote (from their README):");
    for (const c of cs) out(`  - ${c}`);
  }
  out(`\nSubject: ${item.subject}\n`);
  out(item.text);
}

/** Splits an edited file: first line `Subject: ...`, a blank line, then the body. */
export function parseEdited(raw: string): { subject: string; text: string } | null {
  const m = /^Subject:[ \t]*(.*)\r?\n\r?\n([\s\S]*)$/.exec(raw.replace(/^\uFEFF/, ""));
  if (!m) return null;
  const text = m[2]!.replace(/\s+$/, "") + "\n";
  return { subject: m[1]!.trim(), text };
}

export async function runOutreachReview(
  argv: readonly string[],
  deps: OutreachReviewDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const ask = deps.ask ?? ttyAsk;
  const editFile = deps.editFile ?? editorEdit;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        by: { type: "string" },
        note: { type: "string" },
        yes: { type: "boolean", default: false },
        "database-url": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    err((e as Error).message);
    err(OUTREACH_REVIEW_USAGE);
    return 2;
  }
  const v = parsed.values;
  const [action = "list", id] = parsed.positionals;
  if (v.help) {
    out(OUTREACH_REVIEW_USAGE);
    return 0;
  }
  if (!["list", "show", "approve", "edit", "reject", "walk"].includes(action)) {
    err(`unknown review action "${action}"`);
    err(OUTREACH_REVIEW_USAGE);
    return 2;
  }
  if (["show", "approve", "edit", "reject"].includes(action) && !id) {
    err(`review ${action} needs a message id`);
    return 2;
  }
  const by = v.by ?? env.OUTREACH_APPROVER;
  if (["approve", "reject", "walk"].includes(action) && !by?.trim()) {
    err("say who is deciding: --by <name> (or set OUTREACH_APPROVER)");
    return 2;
  }
  const postal = env.COMPANY_POSTAL_ADDRESS;

  const opened = await (deps.openStore ?? openPgDraftStore)(
    outreachDatabaseUrl(v["database-url"], env),
  );
  const store = opened.store;

  const approve = async (item: QueueItem, confirmed: boolean): Promise<number> => {
    if (item.status !== "draft") {
      err(`${item.id} is ${item.status}, not a draft`);
      return 1;
    }
    const lint = lintDraft(item, { postalAddress: postal });
    if (lint.length) {
      err(`refusing to approve ${item.id}: ${lint.join("; ")}`);
      return 1;
    }
    if (!confirmed) {
      const a = await ask(`Approve the email to ${item.email} ("${item.subject}")? [y/N] `);
      if (a === null) {
        err("approve needs a person: run it in a terminal, or pass --yes if the founder said so");
        return 2;
      }
      if (!/^y(es)?$/i.test(a)) {
        out("not approved");
        return 0;
      }
    }
    const ok = await store.approve(item.id, by!.trim(), v.note ?? "founder review (E15 15.5a)");
    out(
      ok
        ? `approved ${item.id} (not sent; see anybench outreach send)`
        : `${item.id} changed; not approved`,
    );
    return ok ? 0 : 1;
  };

  const reject = async (item: QueueItem): Promise<number> => {
    const ok = await store.reject(item.id, by!.trim(), v.note ?? "founder rejected the draft");
    out(
      ok ? `rejected ${item.id} (draft deleted, lead marked rejected)` : `${item.id} not rejected`,
    );
    return ok ? 0 : 1;
  };

  const edit = async (item: QueueItem): Promise<number> => {
    const dir = mkdtempSync(join(tmpdir(), "anybench-draft-"));
    const file = join(dir, `${item.id.slice(0, 8)}.txt`);
    try {
      writeFileSync(file, `Subject: ${item.subject}\n\n${item.text}`, { mode: 0o600 });
      if (!editFile(file)) {
        err("editor exited with an error; nothing saved");
        return 1;
      }
      const edited = parseEdited(readFileSync(file, "utf8"));
      if (!edited) {
        err('could not read the edit: keep "Subject: ..." on the first line, then a blank line');
        return 1;
      }
      const ok = await store.edit(item.id, { ...edited, html: textToHtml(edited.text) });
      const lint = lintDraft(edited, { postalAddress: postal });
      out(
        ok
          ? `saved ${item.id} as a draft; lint ${lint.length ? `FAILS: ${lint.join("; ")}` : "ok"}`
          : `${item.id} could not be edited (already sent?)`,
      );
      return ok ? 0 : 1;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  try {
    if (action === "list") {
      const items = await store.queue();
      if (v.json) {
        out(json(items.map((i) => ({ ...i, lint: lintDraft(i, { postalAddress: postal }) }))));
        return 0;
      }
      if (!items.length) out("review queue is empty");
      for (const i of items) {
        const lint = lintDraft(i, { postalAddress: postal });
        out(
          `${i.id.slice(0, 8)}  ${i.status.padEnd(8)}  ${(i.email ?? "").padEnd(28)}  ${i.subject}${lint.length ? `  [lint: ${lint.length} problem(s)]` : ""}`,
        );
      }
      const drafts = items.filter((i) => i.status === "draft").length;
      err(`${drafts} draft(s) to review, ${items.length - drafts} approved and not sent`);
      return 0;
    }

    if (action === "walk") {
      const items = (await store.queue(["draft"])) as QueueItem[];
      for (const [n, item0] of items.entries()) {
        let item = item0;
        for (;;) {
          out(`\n──── ${n + 1} of ${items.length} ────`);
          showItem(item, postal, out);
          const a = await ask("\n[a]pprove  [e]dit  [r]eject  [s]kip  [q]uit > ");
          if (a === null) {
            err("walk needs a terminal");
            return 2;
          }
          const k = a.toLowerCase()[0];
          if (k === "a") await approve(item, true);
          else if (k === "r") await reject(item);
          else if (k === "e") {
            await edit(item);
            item = await store.get(item.id);
            continue;
          } else if (k === "q") return 0;
          break;
        }
      }
      out("\nno more drafts");
      return 0;
    }

    const item = await store.get(id!);
    if (action === "show") {
      if (v.json) out(json({ ...item, lint: lintDraft(item, { postalAddress: postal }) }));
      else showItem(item, postal, out);
      return 0;
    }
    if (action === "approve") return await approve(item, v.yes);
    if (action === "reject") return await reject(item);
    return await edit(item);
  } catch (e) {
    if (e instanceof DraftNotFoundError) {
      err(e.message);
      return 1;
    }
    throw e;
  } finally {
    await opened.close();
  }
}
