// TDM-164 [15.3a]: what the scout returns, and the mechanical checks that turn it into a brief.
//
//   ScoutOutputSchema   what the Naïve session must produce (its JSON schema is
//                       packages/agents/scout/output.schema.json)
//   verifyScoutOutput   drops every quoted claim that is not on its cited line of the fetched
//                       README / manifest, every metric outside plan.md 17.4 for the subject class,
//                       every sentence that asserts a result we have not measured (17.2 rule 10),
//                       and adds the class's required core metrics
//   ScoutBriefSchema    what is stored on `leads.brief`
//
// The scout has measured nothing. A brief may say "we'd check whether...", never "it is slower".

import { MicroUsdSchema } from "@anybench/core";
import { z } from "zod";
import { unmeasuredAssertions } from "./rule10.js";

// ---- plan.md 17.4: metrics by subject class --------------------------------------------------

export const SUBJECT_CLASSES = [
  "agent_harness",
  "http_agent",
  "cli",
  "service",
  "library",
  "terminal",
  "web_app",
  "other",
] as const;
export type SubjectClass = (typeof SUBJECT_CLASSES)[number];

export interface MetricDef {
  id: string;
  label: string;
}
export interface ClassMetrics {
  /** Required core: gated, always measured. */
  required: readonly MetricDef[];
  optional: readonly MetricDef[];
  /** Never a headline (vanity). Listed so the prompt can name them; never selectable. */
  never: readonly string[];
}

const m = (id: string, label: string): MetricDef => ({ id, label });

/** plan.md section 17.4, one row per class. `other` has no metrics: nothing to benchmark yet. */
export const METRICS_BY_CLASS: Readonly<Record<SubjectClass, ClassMetrics>> = {
  agent_harness: {
    required: [
      m("pass_at_1", "pass@1 on gated tasks"),
      m("pass_hat_k", "pass^k (all k repeats solve it)"),
      m("cost_per_solved_task", "cost per solved task (all spend / solved tasks)"),
      m("time_to_solve", "time-to-solve, failures counted at the cap"),
      m("interventions", "human interventions per task"),
    ],
    optional: [
      m("audited_quality", "audited quality (multi-judge, calibrated)"),
      m("regressions_pass_to_pass", "regressions (PASS_TO_PASS tests broken)"),
      m("merge_conflicts", "merge conflicts"),
      m("speedup_vs_1_worker", "speedup vs 1 worker"),
    ],
    never: ["raw tokens", "turns", "claims", "lines of code"],
  },
  http_agent: {
    required: [
      m("labelled_answer_success", "success on labelled answers"),
      m("cost_per_conversation", "cost per conversation"),
      m("latency_p95", "p95 latency"),
    ],
    optional: [m("policy_violations", "policy violations")],
    never: ["tone"],
  },
  cli: {
    required: [
      m("wall_time_warm", "warm wall time (output gated)"),
      m("wall_time_cold", "cold wall time (output gated)"),
      m("peak_rss", "peak RSS"),
    ],
    optional: [m("startup_time", "startup time")],
    never: ["user CPU alone"],
  },
  service: {
    required: [
      m("latency_p50_p95_p99_open_loop", "p50/p95/p99 at fixed open-loop rates"),
      m("max_rps_within_slo", "max RPS within SLO"),
      m("error_rate", "error rate"),
    ],
    optional: [m("cold_start", "cold start")],
    never: ["peak RPS with errors"],
  },
  library: {
    required: [
      m("ops_per_sec_realistic", "ops/s at realistic sizes"),
      m("allocations", "allocations"),
    ],
    optional: [m("latency_p99", "p99 per operation")],
    never: ["microbenchmarks on trivial input"],
  },
  terminal: {
    required: [
      m("throughput_reference_grid", "throughput with a reference-grid match"),
      m("memory_per_scrollback", "memory per scrollback"),
    ],
    optional: [m("input_latency", "input latency")],
    never: ["bytes/s without a match"],
  },
  web_app: {
    required: [
      m("lcp_inp_cls_throttled", "LCP/INP/CLS on a throttled profile"),
      m("ttfb_p95", "TTFB p95"),
    ],
    optional: [m("bundle_size", "bundle size")],
    never: ["Lighthouse score alone"],
  },
  other: { required: [], optional: [], never: [] },
};

const ALL_METRIC_IDS = [
  ...new Set(
    Object.values(METRICS_BY_CLASS).flatMap((c) => [...c.required, ...c.optional].map((d) => d.id)),
  ),
] as [string, ...string[]];

export const MetricIdSchema = z.enum(ALL_METRIC_IDS);

function metricDef(kind: SubjectClass, id: string): (MetricDef & { required: boolean }) | null {
  const c = METRICS_BY_CLASS[kind];
  const req = c.required.find((d) => d.id === id);
  if (req) return { ...req, required: true };
  const opt = c.optional.find((d) => d.id === id);
  return opt ? { ...opt, required: false } : null;
}

// ---- what the session returns -------------------------------------------------------------------

/** `README.md#L32`, `docs/bench.md#L4`. */
const SOURCE_REF_RE = /^([^#\s]+)#L([1-9]\d*)$/;

export const ScoutOutputSchema = z.strictObject({
  kind: z.enum(SUBJECT_CLASSES),
  fit: z.int().min(0).max(100),
  fit_reason: z.string().min(1).max(800),
  claims: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(500),
        source_ref: z.string().regex(SOURCE_REF_RE),
        what_it_claims: z.string().min(1).max(400),
        /** `own`: about this repo's project. `third_party`: another product's numbers (dropped). */
        about: z.enum(["own", "third_party"]),
      }),
    )
    .max(12),
  what_we_would_measure: z
    .array(z.strictObject({ metric: MetricIdSchema, why: z.string().min(1).max(400) }))
    .max(10),
  gate: z.array(z.string().min(1).max(500)).min(1).max(6),
  compared_against: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(120),
        source: z.string().min(1).max(500),
        why: z.string().min(1).max(400),
      }),
    )
    .max(6),
  caveats: z.array(z.string().min(1).max(400)).max(8),
  contact_ok: z.boolean(),
  why: z.string().min(1).max(1000),
});
export type ScoutOutput = z.infer<typeof ScoutOutputSchema>;

/** The JSON schema Naïve is given (and that packages/agents/scout/output.schema.json holds). */
export function scoutOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ScoutOutputSchema) as Record<string, unknown>;
}

// ---- the stored brief ---------------------------------------------------------------------------

export const DroppedItemSchema = z.strictObject({
  field: z.string(),
  item: z.string(),
  reason: z.enum([
    "quote_not_found",
    "quote_too_short",
    "quote_elided",
    "quote_out_of_context",
    "unknown_file",
    "line_out_of_range",
    "duplicate_claim",
    "third_party_claim",
    "metric_not_for_class",
    "unmeasured_assertion",
    "source_not_found",
    "bad_source",
  ]),
});
export type DroppedItem = z.infer<typeof DroppedItemSchema>;

export const VerifiedClaimSchema = z.strictObject({
  text: z.string(),
  source_ref: z.string(),
  /** Permalink at the ingested commit: .../blob/<sha>/<path>#L<n>. */
  source_url: z.url(),
  what_it_claims: z.string(),
  /** Set when the quote was on a different line than the scout cited; `source_ref` is corrected. */
  cited_ref: z.string().optional(),
});
export type VerifiedClaim = z.infer<typeof VerifiedClaimSchema>;

export const SCOUT_SKIP_REASONS = [
  "below_threshold",
  "no_verified_claims",
  "contact_not_ok",
] as const;

/**
 * Whom an email would go to. `none`: no address known or found (e.g. a GitHub organization with
 * no person). The brief is still written; the writer (15.5a) skips `none` unless a human picks a
 * contact.
 */
export const ScoutContactSchema = z.strictObject({
  status: z.enum(["email_known", "email_found", "none"]),
  reason: z.string(),
});
export type ScoutContact = z.infer<typeof ScoutContactSchema>;
export type ScoutSkipReason = (typeof SCOUT_SKIP_REASONS)[number];

export const ScoutBriefSchema = z.strictObject({
  version: z.literal(1),
  lead_id: z.string(),
  repo_url: z.url(),
  commit: z.string().nullable(),
  kind: z.enum(SUBJECT_CLASSES),
  fit: z.int().min(0).max(100),
  fit_reason: z.string(),
  fit_threshold: z.int().min(0).max(100),
  status: z.enum(["scored", "skipped"]),
  skip_reason: z.enum(SCOUT_SKIP_REASONS).nullable(),
  claims: z.array(VerifiedClaimSchema),
  what_we_would_measure: z.array(
    z.strictObject({
      metric: z.string(),
      label: z.string(),
      required: z.boolean(),
      why: z.string(),
    }),
  ),
  gate: z.array(z.string()).min(1),
  compared_against: z.array(
    z.strictObject({
      name: z.string(),
      source: z.string(),
      /** Resolved permalink when `source` is a repo ref, else the https URL as given. */
      source_url: z.url(),
      /** True when `source` is a `path#Ln` ref that resolved in the fetched material. */
      source_in_repo: z.boolean(),
      /**
       * False when nothing we fetched backs this comparison: an https URL the scout named that is
       * neither a resolved repo line nor linked from the fetched README/manifests. The writer must
       * not present an unverified comparison as something the project itself names.
       */
      verified: z.boolean(),
      verified_by: z.enum(["repo_line", "linked_in_material"]).nullable(),
      why: z.string(),
    }),
  ),
  caveats: z.array(z.string()),
  contact_ok: z.boolean(),
  contact: ScoutContactSchema,
  why: z.string(),
  dropped: z.array(DroppedItemSchema),
  contact_lookup: z
    .strictObject({
      source: z.string(),
      found: z.boolean(),
      /** `skipped_run_cap`: the run cap could not cover the lookup's max cost, so none ran. */
      outcome: z.enum(["found", "not_found", "skipped_run_cap", "error"]),
      /** Counted against the scout run cap. */
      cost_micro_usd: MicroUsdSchema,
    })
    .nullable(),
  naive: z.strictObject({
    session_id: z.string(),
    agent_id: z.string(),
    agent_version: z.int(),
    model: z.string(),
    cost_micro_usd: MicroUsdSchema,
    budget_micro_usd: MicroUsdSchema,
  }),
  created_at: z.iso.datetime({ offset: true }),
});
export type ScoutBrief = z.infer<typeof ScoutBriefSchema>;
/** `leads.brief` jsonb: the brief with micro-USD as decimal strings. */
export type ScoutBriefJson = z.input<typeof ScoutBriefSchema>;

// ---- the material quotes are checked against ---------------------------------------------------

export interface MaterialFile {
  path: string;
  text: string;
}

/** The fetched texts, split into 1-based lines. */
export class ScoutMaterial {
  private readonly files = new Map<string, string[]>();
  constructor(
    files: readonly MaterialFile[],
    /** `https://github.com/o/r`. */
    readonly repoUrl: string,
    /** The ingested commit (permalinks), else the branch. */
    readonly rev: string,
  ) {
    for (const f of files) this.files.set(stripDotSlash(f.path), f.text.split(/\r?\n/));
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  lines(path: string): readonly string[] | undefined {
    return this.files.get(stripDotSlash(path));
  }

  /** Does any fetched file contain this URL (scheme, `www.`, trailing slash and case ignored)? */
  links(url: string): boolean {
    const key = urlKey(url);
    if (key.length < 8) return false;
    for (const lines of this.files.values()) {
      for (const l of lines) {
        for (const m of l.matchAll(/https?:\/\/[^\s)<>"'\]]+/gi)) {
          if (urlKey(m[0]) === key) return true;
        }
      }
    }
    return false;
  }

  permalink(path: string, line: number): string {
    return `${this.repoUrl}/blob/${this.rev}/${stripDotSlash(path)}#L${line}`;
  }

  /** `L<n>: <text>` rows, as the scout sees them. Capped. */
  numbered(path: string, maxLines: number, maxChars: number): { text: string; truncated: boolean } {
    const lines = this.lines(path) ?? [];
    const rows: string[] = [];
    let chars = 0;
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const row = `L${i + 1}: ${lines[i]}`;
      if (chars + row.length + 1 > maxChars) return { text: rows.join("\n"), truncated: true };
      rows.push(row);
      chars += row.length + 1;
    }
    return { text: rows.join("\n"), truncated: lines.length > rows.length };
  }
}

function urlKey(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[#?].*$/, "")
    .replace(/[.,;:]+$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

function stripDotSlash(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * The comparable form of a line or a quote: struck-through text DELETED (`~~x~~`, `<del>`, `<s>`,
 * `<strike>`: a retracted claim is not a claim), other markup dropped (images, HTML tags, link
 * URLs, emphasis, backticks, heading/list/quote markers, table pipes), typographic quotes, dashes
 * and the multiplication sign unified, whitespace collapsed, lowercased.
 */
export function normalizeForQuote(s: string): string {
  return s
    .replace(/~~[^~]*~~/g, " ")
    .replace(/<(del|s|strike)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/×/g, "x")
    .replace(/…/g, "...")
    .replace(/[`*]|__/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$|[.,;:!?)])/g, "$1")
    .replace(/^\s*(?:#{1,6}|>|[-+]|\d+\.)\s+/, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The quote as one contiguous needle: wrapping quote marks and a LEADING or TRAILING ellipsis are
 * dropped. Null when an ellipsis is left inside: an elided quote can splice out a "not".
 */
function quoteNeedle(quote: string): string | null {
  const n = normalizeForQuote(quote)
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^(?:\.\.\.\s*)+|(?:\s*\.\.\.)+$/g, "")
    .replace(/^["'\s]+|["'\s]+$/g, "");
  return n.includes("...") ? null : n;
}

/** Where a clause starts: sentence or clause punctuation, a spaced dash, or a conjunction. */
const CLAUSE_BOUNDARY = /[.!?](?=\s|$)|[;:()]|\s-\s|\b(?:but|however|whereas)\b/g;

/**
 * A negation or disclaimer that, sitting before the quoted span in the same clause, flips or
 * retracts it: "our tool is NOT 10x faster", "we NEVER CLAIMED it is 2x faster".
 */
const DISCLAIMER =
  /\b(?:not|no|never|nor|neither|without|unlike|instead of|rather than|retract\w*|withdr[ae]wn?|disclaim\w*|claimed|false|myth|debunk\w*)\b|n't\b/;

/** A retraction AFTER the span in the same clause: "10x faster (since retracted)". */
const TRAILING_DISCLAIMER =
  /\b(?:retracted|withdrawn|was wrong|is wrong|were wrong|no longer|not true|untrue|false|debunked|incorrect)\b/;

/** The text of `hay` from the start of the clause holding `at`, up to `at`. */
export function clausePrefix(hay: string, at: number): string {
  let start = 0;
  for (const m of hay.slice(0, at).matchAll(CLAUSE_BOUNDARY)) start = (m.index ?? 0) + m[0].length;
  return hay.slice(start, at);
}

type LineMatch = "ok" | "out_of_context" | "absent";

/** Is the needle on the line, with no negation or disclaimer before it in its clause? */
function matchOnLine(line: string, needle: string): LineMatch {
  const hay = normalizeForQuote(line);
  let seen = false;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    seen = true;
    const after = hay.slice(at + needle.length);
    const cut = after.search(/[.!?](?=\s|$)|[;:]/);
    const suffix = cut < 0 ? after : after.slice(0, cut);
    if (!DISCLAIMER.test(clausePrefix(hay, at)) && !TRAILING_DISCLAIMER.test(suffix)) return "ok";
  }
  return seen ? "out_of_context" : "absent";
}

/** Letters and digits in the quote; below this a "quote" is a word, not a claim. */
export const MIN_QUOTE_CHARS = 12;

export type QuoteCheck =
  | { ok: true; path: string; line: number; relocated: boolean }
  | {
      ok: false;
      reason:
        | "quote_not_found"
        | "quote_too_short"
        | "quote_elided"
        | "quote_out_of_context"
        | "unknown_file"
        | "line_out_of_range";
    };

/**
 * Does `quote` appear, contiguously and in context, on line `ref` of the material? If it is not on
 * the cited line but is on exactly one other line of the same file, the ref is corrected
 * (relocated). A match preceded by a negation or disclaimer in its clause is
 * `quote_out_of_context`; struck-through text never matches.
 */
export function checkQuote(material: ScoutMaterial, quote: string, ref: string): QuoteCheck {
  const mref = SOURCE_REF_RE.exec(ref.trim());
  if (!mref) return { ok: false, reason: "unknown_file" };
  const path = stripDotSlash(mref[1]!);
  const line = Number(mref[2]);
  const lines = material.lines(path);
  if (!lines) return { ok: false, reason: "unknown_file" };
  const needle = quoteNeedle(quote);
  if (needle === null) return { ok: false, reason: "quote_elided" };
  if (needle.replace(/[^a-z0-9]/g, "").length < MIN_QUOTE_CHARS) {
    return { ok: false, reason: "quote_too_short" };
  }
  const cited = line <= lines.length ? matchOnLine(lines[line - 1]!, needle) : "absent";
  if (cited === "ok") return { ok: true, path, line, relocated: false };
  const hits: number[] = [];
  let outOfContext = cited === "out_of_context";
  for (let i = 0; i < lines.length; i++) {
    const m = matchOnLine(lines[i]!, needle);
    if (m === "ok") hits.push(i + 1);
    else if (m === "out_of_context") outOfContext = true;
  }
  if (hits.length === 1) return { ok: true, path, line: hits[0]!, relocated: true };
  if (outOfContext && hits.length === 0) return { ok: false, reason: "quote_out_of_context" };
  return {
    ok: false,
    reason: line > lines.length && hits.length === 0 ? "line_out_of_range" : "quote_not_found",
  };
}

/** Does `ref` (`path#L<n>`) name a line that exists in the material? */
export function resolveRef(
  material: ScoutMaterial,
  ref: string,
): { path: string; line: number } | null {
  const mref = SOURCE_REF_RE.exec(ref.trim());
  if (!mref) return null;
  const path = stripDotSlash(mref[1]!);
  const line = Number(mref[2]);
  const lines = material.lines(path);
  if (!lines || line > lines.length) return null;
  return { path, line };
}

// ---- 17.2 rule 10: honest wording (the filter lives in rule10.ts) ----------------------------

export class ScoutBriefRejectedError extends Error {
  readonly code = "unmeasured_assertion" as const;
  constructor(
    readonly field: string,
    readonly sentences: string[],
  ) {
    super(`scout ${field} asserts a result we have not measured: ${sentences.join(" | ")}`);
    this.name = "ScoutBriefRejectedError";
  }
}

// ---- verification -------------------------------------------------------------------------------

export interface VerifiedScoutOutput {
  kind: SubjectClass;
  fit: number;
  fit_reason: string;
  claims: VerifiedClaim[];
  what_we_would_measure: ScoutBrief["what_we_would_measure"];
  gate: string[];
  compared_against: ScoutBrief["compared_against"];
  caveats: string[];
  contact_ok: boolean;
  why: string;
  dropped: DroppedItem[];
}

const HTTPS_URL = z.url({ protocol: /^https$/ });

/**
 * The mechanical gate between the scout's output and a stored brief. Throws
 * ScoutBriefRejectedError when `why` or `fit_reason` asserts an unmeasured result, and when no
 * correctness gate survives (no speed or quality number without a gate).
 */
export function verifyScoutOutput(
  output: ScoutOutput,
  material: ScoutMaterial,
): VerifiedScoutOutput {
  const dropped: DroppedItem[] = [];
  const drop = (field: string, item: string, reason: DroppedItem["reason"]): void => {
    dropped.push({ field, item: item.slice(0, 300), reason });
  };

  for (const field of ["why", "fit_reason"] as const) {
    const bad = unmeasuredAssertions(output[field]);
    if (bad.length) throw new ScoutBriefRejectedError(field, bad);
  }
  const honest = (field: string, text: string): boolean => {
    const bad = unmeasuredAssertions(text);
    if (bad.length) drop(field, text, "unmeasured_assertion");
    return bad.length === 0;
  };

  const claims: VerifiedClaim[] = [];
  const seen = new Set<string>();
  for (const c of output.claims) {
    if (c.about !== "own") {
      drop("claims", `${c.source_ref} ${c.text}`, "third_party_claim");
      continue;
    }
    const check = checkQuote(material, c.text, c.source_ref);
    if (!check.ok) {
      drop("claims", `${c.source_ref} ${c.text}`, check.reason);
      continue;
    }
    const ref = `${check.path}#L${check.line}`;
    const key = `${ref}|${normalizeForQuote(c.text)}`;
    if (seen.has(key)) {
      drop("claims", `${ref} ${c.text}`, "duplicate_claim");
      continue;
    }
    if (!honest("claims.what_it_claims", c.what_it_claims)) continue;
    seen.add(key);
    claims.push({
      text: c.text.trim(),
      source_ref: ref,
      source_url: material.permalink(check.path, check.line),
      what_it_claims: c.what_it_claims,
      ...(check.relocated ? { cited_ref: c.source_ref } : {}),
    });
  }

  const measure: VerifiedScoutOutput["what_we_would_measure"] = [];
  const picked = new Set<string>();
  for (const w of output.what_we_would_measure) {
    const def = metricDef(output.kind, w.metric);
    if (!def) {
      drop("what_we_would_measure", w.metric, "metric_not_for_class");
      continue;
    }
    if (picked.has(def.id)) continue;
    if (!honest("what_we_would_measure.why", w.why)) continue;
    picked.add(def.id);
    measure.push({ metric: def.id, label: def.label, required: def.required, why: w.why });
  }
  // The required core is always measured (17.4), whether or not the scout picked it.
  for (const def of METRICS_BY_CLASS[output.kind].required) {
    if (picked.has(def.id)) continue;
    measure.push({
      metric: def.id,
      label: def.label,
      required: true,
      why: `Required core for ${output.kind} (plan 17.4).`,
    });
  }
  measure.sort((a, b) => Number(b.required) - Number(a.required));

  const gate = output.gate.filter((g) => honest("gate", g));
  if (gate.length === 0)
    throw new ScoutBriefRejectedError("gate", ["no correctness gate survived"]);

  const compared: VerifiedScoutOutput["compared_against"] = [];
  for (const c of output.compared_against) {
    if (!honest("compared_against.why", c.why)) continue;
    const src = c.source.trim();
    if (SOURCE_REF_RE.test(src)) {
      const r = resolveRef(material, src);
      if (!r) {
        drop("compared_against", `${c.name}: ${src}`, "source_not_found");
        continue;
      }
      compared.push({
        name: c.name,
        source: `${r.path}#L${r.line}`,
        source_url: material.permalink(r.path, r.line),
        source_in_repo: true,
        verified: true,
        verified_by: "repo_line",
        why: c.why,
      });
    } else if (HTTPS_URL.safeParse(src).success) {
      // We never fetch the URL itself; it counts as verified only when the fetched material links it.
      const linked = material.links(src);
      compared.push({
        name: c.name,
        source: src,
        source_url: src,
        source_in_repo: false,
        verified: linked,
        verified_by: linked ? "linked_in_material" : null,
        why: c.why,
      });
    } else {
      drop("compared_against", `${c.name}: ${src}`, "bad_source");
    }
  }

  return {
    kind: output.kind,
    fit: output.fit,
    fit_reason: output.fit_reason,
    claims,
    what_we_would_measure: measure,
    gate,
    compared_against: compared,
    caveats: output.caveats.filter((c) => honest("caveats", c)),
    contact_ok: output.contact_ok,
    why: output.why,
    dropped,
  };
}
