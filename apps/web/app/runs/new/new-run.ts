// New run (Ask screen, TDM-101): pure helpers that turn the form into the runs.create body and
// push a file through the uploads contract. Kept out of the component so they test without a DOM.
import {
  ApiClientError,
  apiRoutes,
  GithubSourceSchema,
  MICRO_USD_PER_USD,
  type ApiClient,
  type MicroUsd,
  type RouteInput,
} from "@anybench/core";

export type SourceKind = "github" | "binary" | "claude_setup";
export type ApprovalsPolicy = "reviewer" | "ask_me" | "auto";
export type CreateRunBody = RouteInput<typeof apiRoutes.runs.create>["body"];
type SourceInput = CreateRunBody["source"];

export const APPROVALS_LABEL: Readonly<Record<ApprovalsPolicy, string>> = {
  reviewer: "A reviewer agent plays the human",
  ask_me: "Pause and ask me",
  auto: "Approve every prompt automatically",
};

export const RUNS_PER_SETUP_MIN = 1;
export const RUNS_PER_SETUP_MAX = 20;
export const QUESTION_MAX = 2000;

export interface NewRunForm {
  question: string;
  sourceKind: SourceKind;
  /** github: `owner/repo` or a github.com URL (a `/tree/<ref>` suffix sets the ref). */
  repo: string;
  ref: string;
  /** binary: a URL, or an upload (the upload wins when both are set). */
  binaryUrl: string;
  docsUrl: string;
  /** Other setups to compare against, one name or URL per entry. */
  contenders: readonly string[];
  runsPerSetup: number;
  approvals: ApprovalsPolicy;
  /** The run's spend cap in whole or cent-precise dollars, as typed ("120", "49.50"). */
  budgetUsd: string;
  notifyEmail: boolean;
  notifySlack: boolean;
  /** Review the test plan before it starts (auto_go: false). */
  reviewFirst: boolean;
}

export interface UploadedIds {
  binary?: string;
  docs?: string;
  claudeSetup?: string;
}

export const EMPTY_FORM: NewRunForm = {
  question: "",
  sourceKind: "github",
  repo: "",
  ref: "",
  binaryUrl: "",
  docsUrl: "",
  contenders: [],
  runsPerSetup: 5,
  approvals: "reviewer",
  budgetUsd: "100",
  notifyEmail: true,
  notifySlack: false,
  reviewFirst: true,
};

/** "120" / "49.5" / "49.50" → micro-USD, by string arithmetic only (no float path). */
export function parseUsdToMicro(input: string): MicroUsd | null {
  const m = /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ""));
  if (!m) return null;
  const whole = BigInt(m[1] ?? "0");
  const cents = BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return whole * MICRO_USD_PER_USD + cents * (MICRO_USD_PER_USD / 100n);
}

/** `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo[.git][/tree/<ref>]`. */
export function parseGithubRepo(input: string): { github: string; ref?: string } | null {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return null;
  s = s.replace(/^http:\/\//, "https://").replace(/^https:\/\/www\./, "https://");
  let ref: string | undefined;
  const tree = /^(?:https:\/\/)?github\.com\/([^/]+\/[^/]+)\/tree\/(.+)$/.exec(s);
  if (tree) {
    s = `https://github.com/${tree[1] ?? ""}`;
    ref = tree[2];
  }
  if (!GithubSourceSchema.shape.github.safeParse(s).success) return null;
  return ref ? { github: s, ref } : { github: s };
}

/**
 * The question as the understander agent reads it. The runs.create contract carries question,
 * source, budget and contenders; runs per setup, approvals, notification targets and the named
 * contenders ride along as plain-language preferences until the contract has fields for them.
 */
export function composeQuestion(form: NewRunForm): string {
  const lines = [form.question.trim()];
  const contenders = form.contenders.map((c) => c.trim()).filter(Boolean);
  const prefs: string[] = [];
  if (contenders.length > 0) prefs.push(`Compare against: ${contenders.join("; ")}`);
  prefs.push(`Runs per setup and task: ${form.runsPerSetup}`);
  prefs.push(`Approvals: ${APPROVALS_LABEL[form.approvals]}`);
  const notify = [form.notifyEmail && "email", form.notifySlack && "Slack"].filter(Boolean);
  if (notify.length > 0) prefs.push(`Send results to: ${notify.join(" and ")}`);
  lines.push("", "Preferences:", ...prefs.map((p) => `- ${p}`));
  return lines.join("\n");
}

export type BuildResult = { ok: true; body: CreateRunBody } | { ok: false; errors: string[] };

/** Validate the form (with any finished uploads) into a runs.create body. */
export function buildCreateRunBody(form: NewRunForm, uploads: UploadedIds = {}): BuildResult {
  const errors: string[] = [];
  if (!form.question.trim()) errors.push("Ask a question, e.g. “Is it faster than X?”");

  let source: SourceInput | undefined;
  if (form.sourceKind === "github") {
    const repo = parseGithubRepo(form.repo);
    if (!repo) errors.push("Paste a GitHub repo as owner/repo or a github.com URL.");
    else {
      const ref = form.ref.trim() || repo.ref;
      source = ref
        ? { kind: "github", github: repo.github, ref }
        : { kind: "github", github: repo.github };
    }
  } else if (form.sourceKind === "binary") {
    const binaryUrl = form.binaryUrl.trim();
    const docsUrl = form.docsUrl.trim();
    if (!uploads.binary && !binaryUrl) errors.push("Upload the binary or give a download URL.");
    else if (!uploads.binary && !isHttpUrl(binaryUrl))
      errors.push("The binary URL must start with http:// or https://.");
    if (!uploads.docs && docsUrl && !isHttpUrl(docsUrl))
      errors.push("The docs URL must start with http:// or https://.");
    source = {
      kind: "binary",
      ...(uploads.binary ? { upload_id: uploads.binary } : { binary_url: binaryUrl }),
      ...(uploads.docs ? { docs_upload_id: uploads.docs } : docsUrl ? { docs_url: docsUrl } : {}),
    };
  } else {
    if (!uploads.claudeSetup) errors.push("Upload your Claude Code setup (.claude/ as a .zip).");
    else source = { kind: "claude_setup", upload_id: uploads.claudeSetup };
  }

  const runs = form.runsPerSetup;
  if (!Number.isInteger(runs) || runs < RUNS_PER_SETUP_MIN || runs > RUNS_PER_SETUP_MAX)
    errors.push(`Runs per setup must be ${RUNS_PER_SETUP_MIN}–${RUNS_PER_SETUP_MAX}.`);

  const budget = parseUsdToMicro(form.budgetUsd);
  if (budget === null || budget <= 0n) errors.push("Set a budget cap in dollars, e.g. 100.");

  const question = composeQuestion(form);
  if (question.length > QUESTION_MAX) errors.push("The question is too long.");

  if (errors.length > 0 || !source || budget === null) return { ok: false, errors };

  const body: CreateRunBody = {
    question,
    source,
    budget_micro_usd: budget,
    contenders: [],
    auto_go: !form.reviewFirst,
  };
  const parsed = apiRoutes.runs.create.body.safeParse(body);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  return { ok: true, body };
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** A fresh Idempotency-Key for one create attempt (retries of the same attempt reuse it). */
export function newIdempotencyKey(): string {
  return `web-new-run-${globalThis.crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------------------------
// Uploads (uploads.create → presigned PUT(s) → uploads.complete)

export type UploadPurpose = "binary" | "docs" | "claude_setup";
export type PutFetch = (url: string, init: RequestInit) => Promise<Response>;

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Upload one file and return its upload id once the server has checked size and sha256. */
export async function uploadFile(
  client: ApiClient,
  file: Blob & { name: string },
  purpose: UploadPurpose,
  put: PutFetch = (url, init) => globalThis.fetch(url, init),
): Promise<string> {
  const bytes = await file.arrayBuffer();
  const { upload, plan } = await client.uploads.create({
    body: {
      purpose,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      size_bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    },
  });
  if (plan.kind === "single") {
    const res = await put(plan.url, { method: "PUT", headers: plan.headers, body: bytes });
    if (!res.ok) throw new Error(`Upload of ${file.name} failed (HTTP ${res.status}).`);
    await client.uploads.complete({ params: { id: upload.id }, body: {} });
  } else {
    const parts: { part_number: number; etag: string }[] = [];
    for (const p of plan.parts) {
      const chunk = bytes.slice(p.offset, p.offset + p.size_bytes);
      const res = await put(p.url, { method: "PUT", headers: p.headers, body: chunk });
      const etag = res.headers.get("etag");
      if (!res.ok || !etag)
        throw new Error(`Upload of ${file.name} failed at part ${p.part_number}.`);
      parts.push({ part_number: p.part_number, etag });
    }
    await client.uploads.complete({ params: { id: upload.id }, body: { parts } });
  }
  return upload.id;
}

// ---------------------------------------------------------------------------------------------
// Errors

export const SIGNIN_NEW_RUN = `/signin?redirect_to=${encodeURIComponent("/runs/new")}`;

export type SubmitFailure =
  | { kind: "signed_out" }
  | { kind: "payment"; linkCardUrl: string; reason: string }
  | { kind: "message"; message: string; issues: readonly string[] };

export function describeError(err: unknown): SubmitFailure {
  if (err instanceof ApiClientError) {
    if (err.status === 401) return { kind: "signed_out" };
    if (err.paymentRequired)
      return {
        kind: "payment",
        linkCardUrl: err.paymentRequired.link_card_url,
        reason: err.paymentRequired.reason,
      };
    const message =
      err.status === 0 || err.code === "validation_failed"
        ? "Some fields don't look right."
        : err.status === 429
          ? "Too many runs at once. Wait a minute and try again."
          : err.status >= 500 || err.status === 0
            ? "Anybench couldn't start the run. Try again in a moment."
            : "Anybench couldn't start the run.";
    return { kind: "message", message, issues: err.issues };
  }
  return {
    kind: "message",
    message: err instanceof Error ? err.message : "Something went wrong.",
    issues: [],
  };
}
