// TDM-165 [15.5a]: the outreach writer. For each lead with a scout brief and a known address:
//
//   ONE Naïve writer session (packages/agents/writer) → {subject, opening}
//   → checkOpening (plan 17.2 rule 10, numbers only from the brief's quoted claims, no URLs, no
//     other customers, length) → on any problem, a deterministic template opening instead
//   → composeDraft: greeting + opening + the fixed "what Anybench is" paragraph + the free offer +
//     the link + sign-off + the CAN-SPAM footer (why you got this, reply "unsubscribe", postal
//     address read from COMPANY_POSTAL_ADDRESS)
//   → lintDraft on the whole email → an `outreach_messages` row (kind initial, status draft)
//
// Nothing here sends. A founder approves every draft (`anybench outreach review`), and sending
// (TDM-166) re-runs lintDraft. The model only writes two short fields; everything we promise and
// every compliance line is code, so a model mistake can't put a claim or a missing footer in mail.

import { createHash } from "node:crypto";
import { WRITER_ROLE, writerAgentSpec } from "@anybench/agents";
import {
  ensureAgent,
  NaiveBudgetExceededError,
  NaiveError,
  runSession,
  type NaiveClient,
} from "@anybench/naive";
import { z } from "zod";
import type { MicroUsd } from "./money.js";
import { findRule10Violations } from "./rule10.js";
import { ScoutBriefSchema, type ScoutBrief } from "./scout-brief.js";

export const ANYBENCH_URL = "https://anybench.vercel.app";
export const DEFAULT_WRITER_PER_LEAD_BUDGET_MICRO_USD: MicroUsd = 50_000n;
export const DEFAULT_WRITER_RUN_CAP_MICRO_USD: MicroUsd = 500_000n;
export const DEFAULT_SENDER_NAME = "Jaxon";
const OPENING_MAX_WORDS = 55;
const SUBJECT_MAX_CHARS = 70;
const BODY_MAX_WORDS = 230;

// ---- what the session returns -------------------------------------------------------------------

export const WriterOutputSchema = z.strictObject({
  subject: z.string().min(3).max(120),
  opening: z.string().min(10).max(800),
});
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

/** The JSON schema Naïve is given (and that packages/agents/writer/output.schema.json holds). */
export function writerOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(WriterOutputSchema) as Record<string, unknown>;
}

// ---- the input --------------------------------------------------------------------------------

export const DraftLeadSchema = z.object({
  id: z.string().min(1),
  source: z.string().nullable(),
  company: z.string().nullable(),
  contact: z.string().nullable(),
  email: z.email(),
  githubUrl: z.url(),
  signals: z.record(z.string(), z.unknown()).default({}),
  brief: ScoutBriefSchema,
});
export type DraftLead = z.infer<typeof DraftLeadSchema>;
export type DraftLeadInput = z.input<typeof DraftLeadSchema>;

/** `https://github.com/acme/zippy` → `zippy`. */
export function projectName(lead: Pick<DraftLead, "githubUrl" | "company">): string {
  const seg = new URL(lead.githubUrl).pathname.split("/").filter(Boolean)[1];
  return seg ?? lead.company ?? "your project";
}

const EmailProvenanceSchema = z.looseObject({
  source: z.string().optional(),
  url: z.string().optional(),
});

/** Where the address came from, for the footer's "why you got this" line. */
export function whyYouGotThis(lead: Pick<DraftLead, "source" | "email" | "signals">): string {
  const prov = z
    .looseObject({ provenance: z.looseObject({ email: EmailProvenanceSchema.optional() }) })
    .safeParse(lead.signals);
  const url = prov.success ? prov.data.provenance.email?.url : undefined;
  if (lead.source === "hackathon_optin") {
    return "You're getting this because you asked to have your project benchmarked.";
  }
  if (url) {
    let where = url;
    try {
      const u = new URL(url);
      where =
        u.hostname === "github.com" ? `the ${u.pathname.split("/")[2] ?? ""} README` : u.hostname;
    } catch {
      // keep the raw string
    }
    return `You're getting this because ${lead.email} is listed as a contact on ${where}.`;
  }
  return "You're getting this because your project is public on GitHub.";
}

// ---- checks -----------------------------------------------------------------------------------

const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|dev|ai|io|app|so|land)\b/i;
/** Other customers / benchmarks we've run. Never in outreach. */
const OTHER_CUSTOMERS_RE = /\btandem\b/i;
const CLICHE_RE =
  /\b(hope (this|you're|you are)|amazing|impressive|incredible|love what you|game[- ]chang|revolutionar|guarantee)/i;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Problems with the model's subject + opening. Empty means it may be used. */
export function checkOpening(out: WriterOutput, brief: ScoutBrief, project: string): string[] {
  const issues: string[] = [];
  const both = `${out.subject}\n${out.opening}`;
  for (const v of findRule10Violations(out.opening)) {
    issues.push(`rule 10 (${v.rule}): "${v.match}" in "${v.sentence}"`);
  }
  for (const v of findRule10Violations(out.subject)) {
    issues.push(`rule 10 in subject (${v.rule}): "${v.match}"`);
  }
  const claimText = brief.claims.map((c) => c.text).join("\n");
  for (const n of both.match(NUMBER_RE) ?? []) {
    if (!claimText.includes(n)) issues.push(`number "${n}" is not in a quoted claim`);
  }
  if (URL_RE.test(both)) issues.push("contains a URL or domain");
  if (OTHER_CUSTOMERS_RE.test(both)) issues.push("mentions another customer (Tandem)");
  if (CLICHE_RE.test(both)) issues.push("flattery or a cliché");
  if (/^\s*(hi|hello|hey|dear)\b/i.test(out.opening)) issues.push("opening has a greeting");
  if (words(out.opening) > OPENING_MAX_WORDS) {
    issues.push(`opening is ${words(out.opening)} words (max ${OPENING_MAX_WORDS})`);
  }
  if (out.subject.length > SUBJECT_MAX_CHARS) {
    issues.push(`subject is ${out.subject.length} chars (max ${SUBJECT_MAX_CHARS})`);
  }
  if (!both.toLowerCase().includes(project.toLowerCase())) {
    issues.push(`does not name the project (${project})`);
  }
  return issues;
}

const clip = (s: string, n: number) => {
  const t = s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[>*#|\-\s]+/, "")
    .replace(/[*_`]/g, "");
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…`;
};

/** The no-model opening: quotes their first verified claim, or names the project. */
export function templateOpening(brief: ScoutBrief, project: string): WriterOutput {
  // Prefer a prose line over a markdown table row, which reads badly when quoted.
  const claim = brief.claims.find((c) => !c.text.includes("|")) ?? brief.claims[0];
  const opening = claim
    ? `Your README for ${project} says "${clip(claim.text, 140)}", and I'd like to put that through an independent benchmark.`
    : `I came across ${project} and would like to put it through an independent benchmark.`;
  return { subject: `an independent benchmark of ${project}?`, opening };
}

// ---- the email --------------------------------------------------------------------------------

export interface DraftEmail {
  subject: string;
  text: string;
  html: string;
}

export interface ComposeOptions {
  senderName?: string;
  /** COMPANY_POSTAL_ADDRESS. composeDraft refuses an empty one. */
  postalAddress: string;
}

export class MissingPostalAddressError extends Error {
  constructor() {
    super("COMPANY_POSTAL_ADDRESS is not set: CAN-SPAM needs a postal address in every email");
    this.name = "MissingPostalAddressError";
  }
}

function greeting(lead: DraftLead, project: string): string {
  if (lead.source === "hackathon_optin" && lead.contact) {
    return `Hi ${lead.contact.trim().split(/\s+/)[0]},`;
  }
  return `Hi ${lead.company?.trim() || project} team,`;
}

function alternatives(brief: ScoutBrief, project: string): string {
  const names = brief.compared_against
    .filter((c) => c.verified)
    .map((c) => c.name.replace(/\s*\(.*?\)\s*/g, " ").trim())
    .filter((n) => n.length > 0 && n.length <= 40)
    .slice(0, 2);
  return names.length ? ` (for ${project}: ${names.join(" and ")})` : "";
}

export const FOOTER_UNSUBSCRIBE = `Reply "unsubscribe" and we won't email you again.`;

/** Footer lines (also checked by lintDraft). */
export function footerLines(lead: DraftLead, postalAddress: string): string[] {
  const postal = /^anybench\b/i.test(postalAddress.trim())
    ? postalAddress.trim()
    : `Anybench, ${postalAddress.trim()}`;
  return [whyYouGotThis(lead), FOOTER_UNSUBSCRIBE, postal];
}

export function composeDraft(lead: DraftLead, out: WriterOutput, o: ComposeOptions): DraftEmail {
  const postal = o.postalAddress.trim();
  if (!postal) throw new MissingPostalAddressError();
  const project = projectName(lead);
  const sender = o.senderName?.trim() || DEFAULT_SENDER_NAME;
  const paragraphs = [
    greeting(lead, project),
    out.opening.trim(),
    `Anybench benchmarks agents, harnesses and dev tools against the obvious alternatives${alternatives(lead.brief, project)} on cloud computers. Hidden tests the agent never sees grade every attempt, speed and cost only count for attempts that pass, and when a difference isn't statistically significant the report says so instead of picking a winner.`,
    `We'd like to benchmark ${project} for you, free: we cover the compute. Reply and we'll set it up, or start one yourself at ${ANYBENCH_URL}.`,
    `${sender}\nAnybench · ${ANYBENCH_URL}`,
  ];
  const footer = footerLines(lead, postal);
  const text = `${paragraphs.join("\n\n")}\n\n--\n${footer.join("\n")}\n`;
  return { subject: out.subject.trim(), text, html: textToHtml(text) };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain paragraphs → minimal HTML; the Anybench link is the only anchor. */
export function textToHtml(text: string): string {
  const [body, footer] = text.split(/\n--\n/);
  const link = (s: string) =>
    s
      .split(ANYBENCH_URL)
      .join(`<a href="${ANYBENCH_URL}">${ANYBENCH_URL.replace("https://", "")}</a>`);
  const paras = (body ?? "")
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${link(esc(p)).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  const foot = footer
    ? `\n<p style="color:#777;font-size:12px">${esc(footer.trim()).replace(/\n/g, "<br>")}</p>`
    : "";
  return `<div>${paras}${foot}</div>`;
}

export interface LintContext {
  /** COMPANY_POSTAL_ADDRESS as configured now (empty/undefined → every draft fails). */
  postalAddress: string | undefined;
}

/** Problems that block approval and sending. Empty means the draft may go out. */
export function lintDraft(d: Pick<DraftEmail, "subject" | "text">, ctx: LintContext): string[] {
  const issues: string[] = [];
  const postal = ctx.postalAddress?.trim();
  if (!postal) issues.push("COMPANY_POSTAL_ADDRESS is not set");
  else if (!d.text.includes(postal)) issues.push("the postal address is missing from the footer");
  if (!d.text.includes(FOOTER_UNSUBSCRIBE)) issues.push("the unsubscribe line is missing");
  if (!d.text.includes(ANYBENCH_URL)) issues.push(`no link to ${ANYBENCH_URL}`);
  if (!d.subject.trim()) issues.push("empty subject");
  if (d.subject.length > SUBJECT_MAX_CHARS + 30) issues.push("subject is too long");
  if (OTHER_CUSTOMERS_RE.test(`${d.subject}\n${d.text}`)) {
    issues.push("mentions another customer (Tandem)");
  }
  if (/\{\{|\}\}|TODO|lorem ipsum/i.test(d.text)) issues.push("unfilled placeholder");
  const body = d.text.split(/\n--\n/)[0] ?? "";
  if (words(body) > BODY_MAX_WORDS)
    issues.push(`body is ${words(body)} words (max ${BODY_MAX_WORDS})`);
  for (const v of findRule10Violations(`${d.subject}.\n${body}`)) {
    issues.push(`rule 10 (${v.rule}): "${v.match}" in "${v.sentence}"`);
  }
  return issues;
}

// ---- the session ------------------------------------------------------------------------------

export function writerSessionInput(lead: DraftLead) {
  const b = lead.brief;
  return {
    task: "Write the subject and the opening for this project. Answer with the JSON document only.",
    project: { name: projectName(lead), repo_url: lead.githubUrl },
    kind: b.kind,
    claims: b.claims.slice(0, 6).map((c) => ({ text: c.text, what_it_claims: c.what_it_claims })),
    we_would_measure: b.what_we_would_measure.map((m) => m.label),
    compared_against: b.compared_against.filter((c) => c.verified).map((c) => c.name),
  };
}

export interface WriterOptions {
  naive?: NaiveClient;
  leads: DraftLeadInput[];
  postalAddress: string;
  senderName?: string;
  /** Template openings only, no Naïve session. */
  noModel?: boolean;
  model?: string;
  perLeadBudgetMicroUsd?: MicroUsd;
  runCapMicroUsd?: MicroUsd;
  log?: (line: string) => void;
  capacityRetryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface WrittenDraft {
  leadId: string;
  email: string;
  draft: DraftEmail;
  /** `model`: the writer's opening passed every check; `template`: it didn't, or no model ran. */
  openingFrom: "model" | "template";
  /** Why the model's opening was replaced (empty for `model`). */
  rejected: string[];
  /** lintDraft on the final email (must be empty to approve). */
  lint: string[];
  costMicroUsd: MicroUsd;
  sessionId?: string;
}

export interface WriterRunReport {
  drafts: WrittenDraft[];
  spentMicroUsd: MicroUsd;
  stoppedBy: "run_cap" | null;
}

export async function runWriter(o: WriterOptions): Promise<WriterRunReport> {
  const log = o.log ?? (() => undefined);
  if (!o.postalAddress.trim()) throw new MissingPostalAddressError();
  const perLead = o.perLeadBudgetMicroUsd ?? DEFAULT_WRITER_PER_LEAD_BUDGET_MICRO_USD;
  const runCap = o.runCapMicroUsd ?? DEFAULT_WRITER_RUN_CAP_MICRO_USD;
  if (perLead <= 0n) throw new RangeError("per-lead budget must be > 0 micro-USD");
  const leads = o.leads.map((l) => DraftLeadSchema.parse(l));
  const report: WriterRunReport = { drafts: [], spentMicroUsd: 0n, stoppedBy: null };
  const useModel = !o.noModel && o.naive !== undefined;
  if (!o.noModel && !o.naive) throw new Error("runWriter needs a Naïve client (or noModel)");

  const ensured = useModel
    ? await retryAtCapacity(o, () =>
        ensureAgent(
          o.naive!,
          writerAgentSpec({
            ...(o.model ? { model: o.model } : {}),
            maxTaskMicroUsd: perLead,
            outputSchema: writerOutputJsonSchema(),
          }),
        ),
      )
    : null;

  for (const lead of leads) {
    const project = projectName(lead);
    let out: WriterOutput | null = null;
    let rejected: string[] = [];
    let cost = 0n;
    let sessionId: string | undefined;
    if (ensured && o.naive) {
      if (runCap - report.spentMicroUsd < perLead) {
        report.stoppedBy = "run_cap";
        rejected = ["run cap reached; template opening"];
      } else {
        try {
          const r = await retryAtCapacity(o, () =>
            runSession(o.naive!, {
              agentId: ensured.agent.id,
              agentVersion: ensured.agent.version,
              role: WRITER_ROLE,
              input: writerSessionInput(lead),
              output: { schema: WriterOutputSchema, jsonSchema: writerOutputJsonSchema() },
              budgetMicroUsd: perLead,
              idempotencyKey: keyFor(lead, ensured.fingerprint, perLead),
              metadata: { lead_id: lead.id, repo_url: lead.githubUrl },
              onSession: (s) => {
                sessionId = s.id;
              },
            }),
          );
          cost = r.costMicroUsd;
          if (r.status === "completed") {
            rejected = checkOpening(r.output, lead.brief, project);
            if (!rejected.length) out = r.output;
          } else rejected = ["writer session parked on a question"];
        } catch (err) {
          if (
            err instanceof NaiveBudgetExceededError &&
            err.consumedMicroUsd === null &&
            !sessionId
          ) {
            cost = 0n; // refused at create: nothing ran
          } else if (err instanceof NaiveError) {
            cost =
              (err instanceof NaiveBudgetExceededError ? err.consumedMicroUsd : null) ??
              (await spentBySession(o.naive, sessionId ?? err.sessionId)) ??
              perLead;
          } else throw err;
          rejected = [`writer session failed: ${(err as Error).message}`];
        }
      }
    }
    report.spentMicroUsd += cost;
    const opening = out ?? templateOpening(lead.brief, project);
    const draft = composeDraft(lead, opening, {
      postalAddress: o.postalAddress,
      ...(o.senderName ? { senderName: o.senderName } : {}),
    });
    const lint = lintDraft(draft, { postalAddress: o.postalAddress });
    report.drafts.push({
      leadId: lead.id,
      email: lead.email,
      draft,
      openingFrom: out ? "model" : "template",
      rejected,
      lint,
      costMicroUsd: cost,
      ...(sessionId ? { sessionId } : {}),
    });
    log(
      `lead ${lead.id} ${project}: ${out ? "model" : "template"} opening` +
        `${rejected.length ? ` (${rejected.join("; ")})` : ""}, lint ${lint.length ? lint.join("; ") : "ok"}, ${cost} micro-USD`,
    );
  }
  return report;
}

function keyFor(lead: DraftLead, fingerprint: string, budget: MicroUsd): string {
  const h = createHash("sha256")
    .update(`${lead.id}\n${fingerprint}\n${lead.brief.created_at}\n${budget}`)
    .digest("hex")
    .slice(0, 32);
  return `writer:${lead.id.slice(0, 64)}:${h}`;
}

async function spentBySession(
  naive: NaiveClient,
  id: string | undefined,
): Promise<MicroUsd | null> {
  if (!id) return null;
  try {
    return (await naive.sessions.get(id)).consumedMicroUsd;
  } catch {
    return null;
  }
}

async function retryAtCapacity<T>(o: WriterOptions, fn: () => Promise<T>): Promise<T> {
  const waits = o.capacityRetryDelaysMs ?? [20_000, 60_000];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const wait = waits[attempt];
      if (!(err instanceof NaiveError && err.code === "rate_limited") || wait === undefined)
        throw err;
      o.log?.(`naive at capacity; retrying in ${Math.round(wait / 1000)}s (same idempotency key)`);
      await sleep(wait);
    }
  }
}
