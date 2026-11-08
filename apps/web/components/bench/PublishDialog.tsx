"use client";
// TDM-206: publish a delivered run as a shareable benchmark (POST /runs/:id/publish, plan.md P5).
// A "Publish" pill opens a dialog: slug (prefilled from the run's question, checked live against
// PublishSlugSchema), public or unlisted, and the "rerun on next release" auto-publish toggle
// (off: a rerun waits for review). On 201 it shows the public link, the embed snippet and the
// badge, each with a copy button. A 409 is explained as the API wrote it, plus which of the six
// proof checks did not pass, read from the run's report: only a delivered run whose proof checks
// all passed can be published, and the dialog says so rather than hiding the button's reason.
import {
  ApiClientError,
  apiRoutes,
  PROOF_CHECKS,
  PublishSlugSchema,
  type ProofCheckResult,
  type PublishedBenchmark,
  type RunId,
  type RunState,
} from "@anybench/core";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { apiErrorMessage } from "../../lib/api";
import { useLiveApi } from "../../lib/live/client";
import styles from "./publish.module.css";

/** The slug rule, in words, under the field. Mirrors PublishSlugSchema. */
export const SLUG_RULE =
  "3–64 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.";

/** What each proof check means, for the "what's missing" list on a 409. */
const PROOF_LABEL: Record<(typeof PROOF_CHECKS)[number], string> = {
  oracle_passes: "The reference solution passes every task",
  do_less_fails: "A do-less solution fails the gate",
  smoke_passes: "The smoke run passes",
  regression_scores_lower: "A planted regression scores lower",
  baselines_in_range: "Baselines land in their expected range",
  no_secret_in_kit: "No secret is in the kit",
};

/** A slug from free text: lowercase, runs of anything else to one hyphen, at most 64 chars. */
export function slugify(text: string): string {
  let s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 64) {
    const cut = s.slice(0, 64);
    const dash = cut.lastIndexOf("-");
    s = (dash >= 24 ? cut.slice(0, dash) : cut).replace(/-+$/, "");
  }
  if (s.length < 3) s = s ? `${s}-benchmark` : "benchmark";
  return s;
}

export function embedSnippet(b: Pick<PublishedBenchmark, "embed_url" | "title">): string {
  const origin = new URL(b.embed_url).origin;
  const title = escapeAttr(`${b.title} on Anybench`);
  return [
    `<iframe src="${b.embed_url}" title="${title}" width="100%" height="420" style="border:0" loading="lazy"></iframe>`,
    `<script async src="${origin}/embed.js"></script>`,
  ].join("\n");
}

export function badgeMarkdown(b: Pick<PublishedBenchmark, "badge_url" | "page_url">): string {
  return `[![Anybench](${b.badge_url})](${b.page_url})`;
}

export function badgeHtml(b: Pick<PublishedBenchmark, "badge_url" | "page_url" | "title">): string {
  return `<a href="${b.page_url}"><img src="${b.badge_url}" alt="${escapeAttr(`Anybench: ${b.title}`)}"></a>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The Publish pill plus its dialog. Renders nothing unless the run is delivered: the API would
 * answer 409 for anything else, so the button is not offered.
 */
export function PublishButton({
  runId,
  runState,
  question,
}: {
  runId: string;
  runState: RunState | null;
  question: string;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);
  if (runState !== "delivered") return null;
  return (
    <div className={styles.bar} data-testid="publish-bar">
      <span className={styles.barNote}>
        Share a signed copy of this report: a page, an embed, a badge.
      </span>
      <button
        ref={opener}
        type="button"
        className={styles.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Publish
      </button>
      {open ? <PublishDialog runId={runId} question={question} onClose={close} /> : null}
    </div>
  );
}

type Phase =
  | { kind: "form" }
  | { kind: "busy" }
  | { kind: "conflict"; message: string; missing: ProofCheckResult[] | null }
  | { kind: "error"; message: string }
  | { kind: "done"; benchmark: PublishedBenchmark; version: number };

export function PublishDialog({
  runId,
  question,
  onClose,
}: {
  runId: string;
  question: string;
  onClose: () => void;
}) {
  const client = useLiveApi();
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const slugInput = useRef<HTMLInputElement>(null);
  const [slug, setSlug] = useState(() => slugify(question));
  const [visibility, setVisibility] = useState<"public" | "unlisted">("public");
  const [autoPublish, setAutoPublish] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const slugOk = PublishSlugSchema.safeParse(slug).success;

  useEffect(() => {
    slugInput.current?.focus();
    slugInput.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Focus trap-lite: Tab and Shift+Tab wrap inside the dialog.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !dialog.current) return;
    const items = Array.from(
      dialog.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const publish = async () => {
    if (!slugOk || phase.kind === "busy") return;
    setPhase({ kind: "busy" });
    try {
      const out = await client.call(apiRoutes.publish.publish, {
        params: { id: runId as RunId },
        body: { slug, visibility, auto_publish: autoPublish },
      });
      setPhase({ kind: "done", benchmark: out.benchmark, version: out.version.version });
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        const message = apiErrorMessage(err);
        // What's missing, from the report: null when it can't be read (the message still says why).
        const missing: ProofCheckResult[] | null = await client
          .call(apiRoutes.reports.get, { params: { id: runId as RunId } })
          .then(({ report }) => report.proof.filter((p) => !p.pass))
          .catch(() => null);
        setPhase({ kind: "conflict", message, missing });
      } else {
        setPhase({ kind: "error", message: apiErrorMessage(err) });
      }
    }
  };

  const titleId = `${id}-title`;
  const slugId = `${id}-slug`;
  const ruleId = `${id}-rule`;

  const body =
    phase.kind === "done" ? (
      <Published benchmark={phase.benchmark} version={phase.version} />
    ) : (
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void publish();
        }}
        noValidate
      >
        <div className={styles.field}>
          <label htmlFor={slugId} className={styles.label}>
            Slug
          </label>
          <input
            ref={slugInput}
            id={slugId}
            className={styles.input}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            aria-invalid={!slugOk}
            aria-describedby={ruleId}
            autoComplete="off"
            spellCheck={false}
          />
          <p id={ruleId} className={styles.rule} data-invalid={!slugOk || undefined}>
            {slugOk ? null : <strong>Not a valid slug. </strong>}
            {SLUG_RULE}
          </p>
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>Who can see it</legend>
          <label className={styles.choice}>
            <input
              type="radio"
              name={`${id}-visibility`}
              value="public"
              checked={visibility === "public"}
              onChange={() => setVisibility("public")}
            />
            <span>
              <b>Public</b>
              <small>Listed on /benchmarks; anyone can find it.</small>
            </span>
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name={`${id}-visibility`}
              value="unlisted"
              checked={visibility === "unlisted"}
              onChange={() => setVisibility("unlisted")}
            />
            <span>
              <b>Unlisted</b>
              <small>Only people with the link.</small>
            </span>
          </label>
        </fieldset>

        <label className={styles.toggle}>
          <input
            type="checkbox"
            role="switch"
            checked={autoPublish}
            onChange={(e) => setAutoPublish(e.target.checked)}
          />
          <span>
            <b>Rerun on next release, publish without review</b>
            <small>
              {autoPublish
                ? "New versions go live as soon as their run is delivered."
                : "Off: each new version waits for you to review it before it is public."}
            </small>
          </span>
        </label>

        {phase.kind === "conflict" ? (
          <div className={styles.conflict} role="alert" data-testid="publish-conflict">
            <p className={styles.conflictHead}>This run can&rsquo;t be published yet.</p>
            <p>{phase.message}</p>
            <p className={styles.muted}>
              Only a delivered run whose six proof checks all passed can be published: the page is
              signed and has to stand on its own.
            </p>
            {phase.missing && phase.missing.length ? (
              <ul className={styles.missing} aria-label="Proof checks that did not pass">
                {phase.missing.map((p) => (
                  <li key={p.check}>
                    <span className={styles.failMark} aria-hidden="true">
                      ✕
                    </span>
                    <span>
                      {PROOF_LABEL[p.check]}
                      {p.reason ? <small>{p.reason}</small> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : phase.kind === "error" ? (
          <p className={styles.conflict} role="alert">
            {phase.message}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button type="button" className={styles.quiet} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.pill} disabled={!slugOk || phase.kind === "busy"}>
            {phase.kind === "busy" ? "Publishing…" : "Publish"}
          </button>
        </div>
      </form>
    );

  return createPortal(
    <div
      className={styles.backdrop}
      data-testid="publish-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {phase.kind === "done" ? "Published" : "Publish this benchmark"}
          </h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {body}
      </div>
    </div>,
    document.body,
  );
}

function Published({ benchmark: b, version }: { benchmark: PublishedBenchmark; version: number }) {
  return (
    <div className={styles.done} data-testid="publish-done">
      <p className={styles.muted}>
        Version <span className="num">{version}</span> is signed and{" "}
        {b.visibility === "unlisted"
          ? "unlisted: only people with the link can see it."
          : "public."}
        {b.auto_publish
          ? " New releases rerun and publish without review."
          : " New releases wait for your review."}
      </p>
      <Snippet label="Public link" value={b.page_url} />
      <Snippet label="Embed" value={embedSnippet(b)} multiline />
      <Snippet label="Badge (Markdown)" value={badgeMarkdown(b)} />
      <Snippet label="Badge (HTML)" value={badgeHtml(b)} />
      <div className={styles.actions}>
        <a className={styles.pill} href={b.page_url} target="_blank" rel="noopener noreferrer">
          Open the page
        </a>
      </div>
    </div>
  );
}

function Snippet({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const t = timer;
    return () => {
      if (t.current) clearTimeout(t.current);
    };
  }, []);

  const copy = async () => {
    const ok = await copyText(value, field.current);
    setCopied(ok ? "yes" : "no");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className={styles.snippet}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.snippetRow}>
        {multiline ? (
          <textarea
            ref={field}
            id={id}
            className={styles.code}
            value={value}
            readOnly
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
          />
        ) : (
          <input
            ref={field}
            id={id}
            className={styles.code}
            value={value}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        <button
          type="button"
          className={styles.quiet}
          onClick={() => void copy()}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied === "yes" ? "Copied" : copied === "no" ? "Select and copy" : "Copy"}
        </button>
      </div>
      <span className={styles.srOnly} role="status">
        {copied === "yes" ? `${label} copied` : ""}
      </span>
    </div>
  );
}

/** navigator.clipboard, else select the field and execCommand("copy"). */
async function copyText(
  text: string,
  field: HTMLInputElement | HTMLTextAreaElement | null,
): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection fallback
  }
  if (!field) return false;
  field.focus();
  field.select();
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  }
}
