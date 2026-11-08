// New run flow: pure helpers for the step-by-step screen (which step is ready, the one-line
// summaries, what to send to runs.suggest). The form logic itself stays in new-run.ts.
import type { RunSuggestion, SuggestedAlternative } from "@anybench/core";
import {
  formatBytes,
  isHttpUrl,
  parseGithubRepo,
  parseUsdToMicro,
  uploadSizeError,
  type ApprovalsPolicy,
  type NewRunForm,
} from "./new-run";

export type StepNo = 1 | 2 | 3 | 4;

export interface StepMeta {
  no: StepNo;
  title: string;
  /** The word in the progress bar and the collapsed row. */
  short: string;
  required: boolean;
}

export const STEPS: readonly StepMeta[] = [
  { no: 1, title: "What did you build?", short: "Source", required: true },
  { no: 2, title: "What do you want to find out?", short: "Question", required: true },
  { no: 3, title: "What should it be compared against?", short: "Compare", required: false },
  { no: 4, title: "Review and start", short: "Review", required: false },
];

/** Shown when Anybench has no suggestion (manual flow); a click fills the question box. */
export const EXAMPLE_QUESTIONS: readonly string[] = [
  "Is Tandem faster than Claude Code with subagents?",
  "Is my CLI faster than ripgrep?",
  "Does my agent fix more failing tests than plain Claude Code?",
  "Is my Claude Code setup cheaper per task than the default one?",
];

export interface ChosenFiles {
  binary?: File | undefined;
  docs?: File | undefined;
  claudeSetup?: File | undefined;
}

/** `https://github.com/a/b` → `a/b`. */
export function repoSlug(github: string): string {
  return github
    .replace(/^(https:\/\/)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/** The repo as the screen confirms it: `owner/repo` and the ref (typed, from the URL, or none). */
export function repoConfirmation(form: NewRunForm): { slug: string; ref: string | null } | null {
  if (form.sourceKind !== "github") return null;
  const parsed = parseGithubRepo(form.repo);
  if (!parsed) return null;
  return { slug: repoSlug(parsed.github), ref: form.ref.trim() || parsed.ref || null };
}

/** Step 1 is done when the chosen source is complete enough to send. */
export function sourceReady(form: NewRunForm, files: ChosenFiles): boolean {
  if (form.sourceKind === "github") return parseGithubRepo(form.repo) !== null;
  if (form.sourceKind === "binary") {
    const binaryOk = files.binary
      ? uploadSizeError(files.binary.size, "binary") === null
      : isHttpUrl(form.binaryUrl.trim());
    const docsUrl = form.docsUrl.trim();
    const docsOk = files.docs
      ? uploadSizeError(files.docs.size, "docs") === null
      : docsUrl === "" || isHttpUrl(docsUrl);
    return binaryOk && docsOk;
  }
  return !!files.claudeSetup && uploadSizeError(files.claudeSetup.size, "claude_setup") === null;
}

export function stepReady(no: StepNo, form: NewRunForm, files: ChosenFiles): boolean {
  if (no === 1) return sourceReady(form, files);
  if (no === 2) return form.question.trim() !== "";
  return true;
}

function fileOrUrl(file: File | undefined, url: string): string | null {
  if (file) return `${file.name} (${formatBytes(file.size)})`;
  const u = url.trim();
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return u;
  }
}

export function sourceSummary(form: NewRunForm, files: ChosenFiles): string {
  if (form.sourceKind === "github") {
    const c = repoConfirmation(form);
    if (!c) return "No repo yet";
    return `${c.slug} · ${c.ref ?? "default branch"}`;
  }
  if (form.sourceKind === "binary") {
    const bin = fileOrUrl(files.binary, form.binaryUrl) ?? "no binary yet";
    const docs = fileOrUrl(files.docs, form.docsUrl);
    return docs ? `Binary ${bin} + docs ${docs}` : `Binary ${bin}`;
  }
  return files.claudeSetup
    ? `Claude Code setup ${files.claudeSetup.name} (${formatBytes(files.claudeSetup.size)})`
    : "No Claude Code setup yet";
}

/** The setups the user wants compared: kept suggestions first, then the ones they typed. */
export function comparedNames(
  kept: readonly SuggestedAlternative[],
  contenders: readonly string[],
): string[] {
  const out: string[] = [];
  for (const n of [...kept.map((a) => a.name), ...contenders]) {
    const t = n.trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function compareSummary(names: readonly string[]): string {
  return names.length === 0
    ? "Anybench picks the obvious alternatives"
    : `${names.join(", ")}, plus anything obvious Anybench finds`;
}

const APPROVALS_SHORT: Readonly<Record<ApprovalsPolicy, string>> = {
  reviewer: "a reviewer agent approves",
  ask_me: "pauses to ask you",
  auto: "approves automatically",
};

export function optionsSummary(form: NewRunForm): string {
  const runs = Number.isInteger(form.runsPerSetup) ? `${form.runsPerSetup}` : "?";
  const budget = parseUsdToMicro(form.budgetUsd) !== null ? `$${form.budgetUsd.trim()}` : "no";
  const notify = [form.notifyEmail && "email", form.notifySlack && "Slack"].filter(Boolean);
  return [
    `${runs} runs per setup`,
    APPROVALS_SHORT[form.approvals],
    `${budget} cap`,
    notify.length ? `results by ${notify.join(" and ")}` : "no notifications",
    form.reviewFirst ? "you review the plan first" : "starts without a plan review",
  ].join(" · ");
}

/** runs.suggest body for a GitHub source, or null when the source is not a valid repo. */
export function suggestBody(
  form: NewRunForm,
): { key: string; body: { source: { kind: "github"; github: string; ref?: string } } } | null {
  if (form.sourceKind !== "github") return null;
  const parsed = parseGithubRepo(form.repo);
  if (!parsed) return null;
  const ref = form.ref.trim() || parsed.ref;
  return {
    key: `${repoSlug(parsed.github).toLowerCase()}@${ref ?? ""}`,
    body: { source: { kind: "github", github: parsed.github, ...(ref ? { ref } : {}) } },
  };
}

export type SuggestState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; data: RunSuggestion }
  | { status: "failed"; key: string };

/**
 * How long the screen waits for runs.suggest before carrying on without it (quietly). The request
 * is aborted then, so a gateway that holds it for a minute doesn't keep a connection open.
 */
export const SUGGEST_CLIENT_TIMEOUT_MS = 20_000;
