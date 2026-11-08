"use client";
// The share bar on a public benchmark (TDM-204): the link, the embed and the badge, one click to
// copy each. Snippets come from the same helpers the Publish dialog uses, so they always match.
import type { PublishedBenchmark } from "@anybench/core";
import { useRef, useState } from "react";
import styles from "./bench.module.css";
import { badgeHtml, badgeMarkdown, embedSnippet } from "./PublishDialog";

type Kind = "link" | "embed" | "badge" | "html";

export function ShareBar({ benchmark: b }: { benchmark: PublishedBenchmark }) {
  const [kind, setKind] = useState<Kind>("link");
  const [copied, setCopied] = useState<Kind | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const text =
    kind === "link"
      ? b.page_url
      : kind === "embed"
        ? embedSnippet(b)
        : kind === "badge"
          ? badgeMarkdown(b)
          : badgeHtml(b);

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok && field.current) {
      field.current.select();
      try {
        ok = document.execCommand?.("copy") ?? false;
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    }
  };

  return (
    <div className={styles.share} data-testid="share-bar">
      <div className={styles.shareTabs} role="tablist" aria-label="Share">
        {(
          [
            ["link", "Link"],
            ["embed", "Embed"],
            ["badge", "Badge (Markdown)"],
            ["html", "Badge (HTML)"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={styles.shareRow}>
        <textarea
          ref={field}
          readOnly
          rows={kind === "link" ? 1 : 2}
          value={text}
          aria-label={`${kind} to share`}
          data-testid="share-text"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className={styles.shareCopy} onClick={() => void copy()}>
          {copied === kind ? "Copied" : "Copy"}
        </button>
      </div>
      <p className={styles.shareMore}>
        <a
          href={`https://x.com/intent/post?url=${encodeURIComponent(b.page_url)}&text=${encodeURIComponent(b.title)}`}
          target="_blank"
          rel="noreferrer"
        >
          Post on X
        </a>
        <a
          href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(b.page_url)}`}
          target="_blank"
          rel="noreferrer"
        >
          Share on LinkedIn
        </a>
      </p>
    </div>
  );
}
