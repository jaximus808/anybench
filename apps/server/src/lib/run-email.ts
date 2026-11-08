// The run-owner email (jobs/run-notify.ts): "your benchmark is done" when a run is delivered, and a
// short note when it needs the owner, failed, or we cancelled it. Pure: report in, {subject, html,
// text} out.
//
// Honesty rules (plan.md 17.2): the verdict is the report's own `answer` text, verbatim (the
// subject is a prefix of it, never a paraphrase), so the email can't call a winner the stats
// didn't. A measured number only shows when its correctness gate passed: the report schema
// already nulls the rest, and they render as "–" with a footnote saying why.
import { formatUsd, type ContenderResult, type Report } from "@anybench/core";

export const NOTIFY_STATES = ["delivered", "needs_human", "failed", "cancelled"] as const;
export type NotifyState = (typeof NOTIFY_STATES)[number];

export interface RunEmailInput {
  runId: string;
  state: NotifyState;
  /** runs.question (the "Preferences:" block the New run form appends is dropped). */
  question: string;
  report: Report | null;
  /** Why it stopped (hold reason, failure reason, cancel reason); shown on the short emails. */
  reason: string | null;
  /** True when this run was not billed (comped, our failure, our cancel, a hold). */
  nothingBilled: boolean;
  /** Web base URL; the button links to `<webUrl>/runs/<id>`. */
  webUrl: string;
  postalAddress: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

type Requirement = ContenderResult["requirements"][number];

// ---- text helpers --------------------------------------------------------------------------------

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/** The question as asked, without the form's appended "Preferences:" block. */
export function questionOf(question: string): string {
  return oneLine(question.split(/\n\s*Preferences:/)[0] ?? question);
}

/**
 * The report answer's headline, as apps/web/components/report/model.ts splitAnswer does: the text
 * before the " proof: …" and " tokens: …" markers the summary analyst appends.
 */
export function splitAnswer(answer: string): { headline: string; proofLabel: string | null } {
  const text = answer.trim();
  const at = (marker: string) => {
    if (text.startsWith(marker)) return 0;
    const i = text.indexOf(` ${marker}`);
    return i < 0 ? -1 : i + 1;
  };
  const p = at("proof: ");
  const t = at("tokens: ");
  const cuts = [p, t].filter((i) => i > 0).sort((a, b) => a - b);
  const headline = (cuts.length ? text.slice(0, cuts[0]) : text).trim() || text;
  let proofLabel: string | null = null;
  if (p >= 0) {
    const end = t > p ? t : text.length;
    proofLabel = text.slice(p, end).trim() || null;
  }
  return { headline, proofLabel };
}

/** Cut at the first `,` `;` or sentence end outside parentheses. */
function firstClause(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "," || c === ";")) return s.slice(0, i);
    else if (depth === 0 && c === "." && (i === s.length - 1 || s[i + 1] === " "))
      return s.slice(0, i);
  }
  return s;
}

/**
 * The subject's one-line verdict: a verbatim prefix of the report's headline. The primary
 * requirement's statement ("tandem vs claude-code-solo: no detectable difference at n=3 tasks
 * (4 vs 7 trials)"), or the per-task finding when every task agreed, or the first clause.
 */
export function oneLineVerdict(headline: string): string {
  let s = oneLine(headline);
  const perTask = "On the tasks tested: ";
  const primary = "(the primary requirement): ";
  if (s.startsWith(perTask)) s = s.slice(perTask.length);
  else if (s.includes(primary)) s = s.slice(s.indexOf(primary) + primary.length);
  else if (s.startsWith("Result: ")) s = s.slice("Result: ".length);
  return cap(firstClause(s).trim(), 140);
}

// ---- report → table ------------------------------------------------------------------------------

function num(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  const abs = Math.abs(v);
  return Number(v.toPrecision(abs >= 100 ? 4 : 3)).toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });
}

/** A requirement's value in its unit, like the web report (micro-USD as dollars, ratios as %). */
export function formatValue(r: Requirement | undefined): string {
  if (!r || r.value === null) return "–";
  const v = r.value;
  if (r.unit === "micro-USD" && Number.isSafeInteger(Math.round(v)))
    return formatUsd(BigInt(Math.round(v)), { decimals: Math.abs(v) < 10_000 ? 4 : 2 });
  if (r.unit === "ratio" || r.unit === "rate") return `${num(v * 100)}%`;
  if (r.unit === "s" && v >= 120) return `${num(v / 60)} min`;
  return r.unit ? `${num(v)} ${r.unit}` : num(v);
}

const isPass = (r: Requirement) =>
  r.type === "measured" && (r.unit === "ratio" || r.unit === "rate");
const isWall = (r: Requirement) =>
  r.type === "measured" &&
  (r.requirement_id === "wall" ||
    /wall/i.test(r.title) ||
    ((r.unit === "s" || r.unit === "ms") && /time to (finish|complete)/i.test(r.title)));
const isCost = (r: Requirement) => r.type === "measured" && r.unit === "micro-USD";

export interface SetupRow {
  name: string;
  baseline: boolean;
  passRate: string;
  n: number | null;
  wall: string | null;
  cost: string | null;
}

/** One row per setup: pass rate (with n), wall time and cost, when the report has them. */
export function setupRows(report: Report): {
  rows: SetupRow[];
  hasWall: boolean;
  hasCost: boolean;
  passTitle: string | null;
} {
  let passTitle: string | null = null;
  const rows = report.contenders.map((c): SetupRow => {
    const pass = c.requirements.find(isPass);
    if (pass && !passTitle) passTitle = pass.title;
    const wall = c.requirements.find(isWall);
    const cost = c.requirements.find(isCost);
    return {
      name: c.name,
      baseline: c.role === "baseline",
      passRate: formatValue(pass),
      n: pass?.n ?? null,
      wall: wall ? formatValue(wall) : null,
      cost: cost ? formatValue(cost) : null,
    };
  });
  const present = (k: "wall" | "cost") => rows.some((r) => r[k] !== null && r[k] !== "–");
  return { rows, hasWall: present("wall"), hasCost: present("cost"), passTitle };
}

/** "How it was evaluated", one line, from what the report records. */
export function evaluatedLine(report: Report, proofLabel: string | null): string {
  const tasks = report.per_task?.tasks ?? [];
  const taskText = tasks.length
    ? `the same ${tasks.length} task${tasks.length === 1 ? "" : "s"} (${tasks.join(", ")})`
    : "the same tasks";
  const gates = [
    ...new Set(
      report.contenders.flatMap((c) =>
        c.requirements.filter((r) => r.type === "measured" && r.gate_id).map((r) => r.gate_id!),
      ),
    ),
  ];
  const trials = report.contenders
    .map((c) => c.requirements.find(isPass)?.n ?? 0)
    .reduce((a, b) => a + b, 0);
  const parts = [
    `Every setup ran ${taskText}`,
    trials > 0 ? `${trials} measured trials` : null,
    `a number counts only when its correctness gate passed${gates.length ? ` (${gates.join(", ")})` : ""}`,
    report.contenders.some((c) => c.requirements.some((r) => r.comparison))
      ? "each setup is compared with the baseline, Holm-corrected"
      : null,
  ].filter(Boolean);
  const proof = proofLabel ? ` ${proofLabel.replace(/^proof:\s*/, "Proof: ")}.` : "";
  return `${parts.join("; ")}.${proof}`;
}

// ---- rendering -----------------------------------------------------------------------------------

const C = {
  ink: "#16181d",
  muted: "#5b6170",
  line: "#e4e6eb",
  soft: "#f5f6f8",
  accent: "#1f4fd6",
};

function shell(opts: { preheader: string; body: string; footer: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anybench</title></head>
<body style="margin:0;padding:0;background:${C.soft};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:10px;">
<tr><td style="padding:28px 32px 8px 32px;font:600 15px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};letter-spacing:0.02em;">Anybench</td></tr>
<tr><td style="padding:8px 32px 28px 32px;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};">
${opts.body}
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
<tr><td style="padding:16px 32px;font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.muted};">${opts.footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px 0;"><tr><td style="background:${C.accent};border-radius:8px;">
<a href="${esc(href)}" style="display:inline-block;padding:14px 28px;font:600 16px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;">${esc(label)}</a>
</td></tr></table>`;
}

const p = (html: string, style = "") => `<p style="margin:0 0 14px 0;${style}">${html}</p>`;

function footerOf(input: RunEmailInput): { html: string; text: string } {
  const why = "You're receiving this because you started this run on Anybench.";
  const addr = input.postalAddress?.trim() ? oneLine(input.postalAddress) : null;
  // COMPANY_POSTAL_ADDRESS may already start with the company name.
  const line = addr ? (/^anybench\b/i.test(addr) ? addr : `Anybench · ${addr}`) : "Anybench";
  return { html: `${esc(why)}<br>${esc(line)}`, text: `${why}\n${line}` };
}

export function runUrl(webUrl: string, runId: string): string {
  return `${webUrl.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}`;
}

function renderDelivered(input: RunEmailInput, url: string): RenderedEmail {
  const report = input.report;
  const question = questionOf(input.question);
  if (!report) {
    // Delivered without a stored report should not happen; say so plainly rather than guess.
    const subject = "Your Anybench result is ready";
    const text = `Your benchmark finished.\n\nYou asked: ${question}\n\nView the full report: ${url}`;
    const body = [
      p(`<strong>Your benchmark finished.</strong>`),
      p(`You asked: ${esc(question)}`, `color:${C.muted};`),
      button(url, "View the full report"),
    ].join("\n");
    const f = footerOf(input);
    return {
      subject,
      html: shell({ preheader: "Your benchmark finished.", body, footer: f.html }),
      text: `${text}\n\n--\n${f.text}\n`,
    };
  }

  const { headline: full, proofLabel } = splitAnswer(report.answer);
  const scope = report.per_task?.scope ?? null;
  // The scope sentence closes the answer too; show it once, on its own line.
  const headline =
    scope && full.endsWith(scope) ? full.slice(0, full.length - scope.length).trim() : full;
  const verdict = oneLineVerdict(headline);
  const subject = cap(`Your Anybench result: ${verdict}`, 180);
  const { rows, hasWall, hasCost, passTitle } = setupRows(report);
  const evaluated = evaluatedLine(report, proofLabel);
  const anyDash = rows.some(
    (r) => r.passRate === "–" || (hasWall && r.wall === "–") || (hasCost && r.cost === "–"),
  );

  const th = (s: string, align = "left") =>
    `<th align="${align}" style="padding:8px 10px;border-bottom:1px solid ${C.line};font-size:12px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:0.04em;">${esc(s)}</th>`;
  const td = (s: string, align = "left") =>
    `<td align="${align}" style="padding:10px;border-bottom:1px solid ${C.line};font-size:14px;color:${C.ink};">${s}</td>`;
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 6px 0;">
<tr>${th("Setup")}${th("Pass rate", "right")}${hasWall ? th("Wall time", "right") : ""}${hasCost ? th("Cost", "right") : ""}</tr>
${rows
  .map(
    (r) =>
      `<tr>${td(`${esc(r.name)}${r.baseline ? ` <span style="color:${C.muted};font-size:12px;">(baseline)</span>` : ""}`)}${td(
        `${esc(r.passRate)}${r.n !== null ? ` <span style="color:${C.muted};font-size:12px;">n=${r.n}</span>` : ""}`,
        "right",
      )}${hasWall ? td(esc(r.wall ?? "–"), "right") : ""}${hasCost ? td(esc(r.cost ?? "–"), "right") : ""}</tr>`,
  )
  .join("\n")}
</table>`;
  const notes = [
    passTitle ? `Pass rate: ${passTitle}.` : null,
    anyDash ? "– means no number passed its correctness gate, so none is shown." : null,
  ].filter(Boolean) as string[];

  const body = [
    p(`<strong>Your benchmark is done.</strong>`, "font-size:17px;"),
    p(`You asked: ${esc(question)}`, `color:${C.muted};`),
    `<div style="margin:18px 0;padding:16px 18px;background:${C.soft};border-left:3px solid ${C.accent};border-radius:6px;font-size:15px;line-height:1.55;">${esc(headline)}</div>`,
    table,
    notes.length ? p(esc(notes.join(" ")), `font-size:12px;color:${C.muted};`) : "",
    scope ? p(`<strong>Scope:</strong> ${esc(scope)}`, "font-size:14px;") : "",
    input.nothingBilled ? p("This run was not billed.", `font-size:14px;color:${C.muted};`) : "",
    button(url, "View the full report"),
    p(
      `<strong>How it was evaluated:</strong> ${esc(evaluated)}`,
      `font-size:13px;color:${C.muted};margin-top:18px;`,
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const col = (s: string, w: number) => (s.length >= w ? `${s} ` : s.padEnd(w));
  const nameW = Math.max(6, ...rows.map((r) => r.name.length + (r.baseline ? 11 : 0))) + 2;
  const textTable = [
    `${col("Setup", nameW)}${col("Pass rate", 16)}${hasWall ? col("Wall time", 12) : ""}${hasCost ? "Cost" : ""}`.trimEnd(),
    ...rows.map((r) =>
      `${col(`${r.name}${r.baseline ? " (baseline)" : ""}`, nameW)}${col(`${r.passRate}${r.n !== null ? ` n=${r.n}` : ""}`, 16)}${hasWall ? col(r.wall ?? "–", 12) : ""}${hasCost ? (r.cost ?? "–") : ""}`.trimEnd(),
    ),
  ].join("\n");
  const f = footerOf(input);
  const text = [
    "Your benchmark is done.",
    `You asked: ${question}`,
    headline,
    textTable,
    notes.join(" "),
    scope ? `Scope: ${scope}` : "",
    input.nothingBilled ? "This run was not billed." : "",
    `View the full report: ${url}`,
    `How it was evaluated: ${evaluated}`,
    `--\n${f.text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    subject,
    html: shell({ preheader: verdict, body, footer: f.html }),
    text: `${text}\n`,
  };
}

const SHORT: Record<Exclude<NotifyState, "delivered">, { subject: string; lead: string }> = {
  needs_human: {
    subject: "Your Anybench run needs your input",
    lead: "Your run is paused and needs a decision from you before it can go on.",
  },
  failed: {
    subject: "Your Anybench run failed",
    lead: "Your run stopped before it could deliver a report.",
  },
  cancelled: {
    subject: "Your Anybench run was stopped",
    lead: "We stopped your run on our side before it could deliver a report.",
  },
};

function renderShort(
  input: RunEmailInput & { state: Exclude<NotifyState, "delivered"> },
  url: string,
): RenderedEmail {
  const s = SHORT[input.state];
  const question = questionOf(input.question);
  const reason = input.reason ? cap(oneLine(input.reason), 400) : null;
  const billing =
    input.state === "needs_human"
      ? "Nothing is billed while it waits."
      : input.nothingBilled
        ? "Nothing was billed for this run."
        : "Charges for this run are listed on the run page.";
  const label = input.state === "needs_human" ? "Open the run" : "View the run";
  const f = footerOf(input);
  const body = [
    p(`<strong>${esc(s.lead)}</strong>`),
    p(`You asked: ${esc(question)}`, `color:${C.muted};`),
    reason ? p(`What happened: ${esc(reason)}`) : "",
    p(esc(billing)),
    button(url, label),
  ]
    .filter(Boolean)
    .join("\n");
  const text = [
    s.lead,
    `You asked: ${question}`,
    reason ? `What happened: ${reason}` : "",
    billing,
    `${label}: ${url}`,
    `--\n${f.text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    subject: s.subject,
    html: shell({ preheader: s.lead, body, footer: f.html }),
    text: `${text}\n`,
  };
}

export function renderRunEmail(input: RunEmailInput): RenderedEmail {
  const url = runUrl(input.webUrl, input.runId);
  if (input.state === "delivered") return renderDelivered(input, url);
  return renderShort({ ...input, state: input.state }, url);
}
