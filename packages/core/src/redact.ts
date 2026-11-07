// Secret redaction, applied before anything is persisted (logs, events, transcripts, reports).
// Two layers: exact match on every secret in scope for the trial (wins, keeps its name), then
// known key patterns. Replacements are `[REDACTED:NAME]`, which contains no quote or backslash,
// so redacting a JSON document or a stream-json line keeps it valid JSON.
// Spec: plan.md section 9.
//
// Streams: redact whole lines (or whole JSON events), not arbitrary byte chunks; a secret split
// across two chunks cannot be matched by either half.

/** Secrets in scope for a trial or job: NAME -> value. Empty/undefined values are ignored. */
export type SecretsInScope = Readonly<Record<string, string | null | undefined>>;

interface KeyPattern {
  name: string;
  re: RegExp;
}

/**
 * Known key shapes, most specific first (a match is replaced before the next pattern runs, and
 * `[REDACTED:...]` never matches a later one). Distinctive prefixes match anywhere, even glued to
 * the previous word or a JSON escape like `\n`: over-redacting a log line is cheaper than a leak.
 */
export const SECRET_PATTERNS: readonly KeyPattern[] = [
  { name: "ANTHROPIC_API_KEY", re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "OPENAI_API_KEY", re: /sk-proj-[A-Za-z0-9_-]{8,}/g },
  // Generic OpenAI-style `sk-...` (legacy, sk-svcacct-, sk-admin-): needs 20+ chars incl. a digit,
  // so ordinary words like "task-management-system-for-teams" are left alone.
  { name: "OPENAI_API_KEY", re: /sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g },
  { name: "GITHUB_TOKEN", re: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: "GITHUB_TOKEN", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "STRIPE_SECRET_KEY", re: /sk_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: "STRIPE_RESTRICTED_KEY", re: /rk_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: "STRIPE_WEBHOOK_SECRET", re: /whsec_[A-Za-z0-9+/=]{10,}/g },
  { name: "ANYBENCH_API_KEY", re: /ab_(?:live|test)_[A-Za-z0-9_-]{16,}/g },
];

/** Normalise a secret's name into the `[REDACTED:NAME]` token alphabet (A-Z, 0-9, _). */
function tokenName(name: string): string {
  const n = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return n.length > 0 ? n : "SECRET";
}

export function redactedToken(name: string): string {
  return `[REDACTED:${tokenName(name)}]`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The literal forms a value can take in text: raw, JSON-escaped once, and twice (JSON in JSON). */
function literalForms(value: string): string[] {
  const forms = [value];
  let cur = value;
  for (let i = 0; i < 2; i++) {
    const next = JSON.stringify(cur).slice(1, -1);
    if (next === cur) break;
    forms.push(next);
    cur = next;
  }
  return forms;
}

export type Redactor = (text: string) => string;

/** Precompile a redactor for a fixed set of secrets (use per trial on every log/stream line). */
export function createRedactor(secretsInScope: SecretsInScope = {}): Redactor {
  const byLiteral = new Map<string, string>();
  for (const [name, value] of Object.entries(secretsInScope)) {
    if (typeof value !== "string" || value.length === 0) continue;
    for (const form of literalForms(value)) {
      if (!byLiteral.has(form)) byLiteral.set(form, redactedToken(name));
    }
  }
  // Longest first, so a secret that contains another secret is replaced whole.
  const literals = [...byLiteral.keys()].sort((a, b) => b.length - a.length);
  const exact =
    literals.length > 0 ? new RegExp(literals.map(escapeRegExp).join("|"), "g") : undefined;

  return (text: string): string => {
    let out = exact
      ? text.replace(exact, (m) => byLiteral.get(m) ?? redactedToken("SECRET"))
      : text;
    for (const { name, re } of SECRET_PATTERNS) {
      out = out.replace(re, redactedToken(name));
    }
    return out;
  };
}

/** Redact one string: exact secrets in scope, then known key patterns. */
export function redact(text: string, secretsInScope: SecretsInScope = {}): string {
  return createRedactor(secretsInScope)(text);
}

/**
 * Redact every string (values and keys) inside a JSON-like value, e.g. an event payload, before
 * it is written. Returns a new value; the input is not modified.
 */
export function redactJson<T>(value: T, secretsInScope: SecretsInScope | Redactor = {}): T {
  const r = typeof secretsInScope === "function" ? secretsInScope : createRedactor(secretsInScope);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return r(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[r(k)] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
