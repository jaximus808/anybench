"use client";
// Share panel (E12 12.7): the owner publishes a delivered run as a signed public page, then copies
// the link, the badge (Markdown or HTML) or the embed code, or posts it to X. Withdraw keeps the
// link alive but makes the page and badge read "withdrawn". Mount it with one line:
//   <SharePanel runId={runId} runState={run.state} />
// (without `runState` it reads the run itself).
import {
  ApiClientError,
  apiRoutes,
  type ApiClient,
  type PublicationSummary,
  type RunId,
  type RunState,
} from "@anybench/core";
import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import {
  badgeHtml,
  badgeMarkdown,
  embedHtml,
  heroSentence,
  xIntentUrl,
} from "../../lib/publish/view";
import styles from "./publish.module.css";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; runState: RunState; publication: PublicationSummary | null };

const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SharePanel({
  runId,
  runState,
  client,
}: {
  runId: string;
  runState?: RunState;
  client?: ApiClient;
}) {
  const c = client ?? api();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = runId as RunId;

  const load = useCallback(async () => {
    try {
      const [state, { publication }] = await Promise.all([
        runState ?? c.call(apiRoutes.runs.get, { params: { id } }).then((d) => d.run.state),
        c.call(apiRoutes.publications.get, { params: { id } }).catch((e: unknown) => {
          // An API without the publication routes yet answers 404: nothing is published.
          if (e instanceof ApiClientError && e.status === 404) return { publication: null };
          throw e;
        }),
      ]);
      setState({ kind: "ready", runState: state, publication });
    } catch (e) {
      setState({ kind: "error", message: apiErrorMessage(e) });
    }
  }, [c, id, runState]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(route: "publish" | "unpublish") {
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      const { publication } = await c.call(apiRoutes.publications[route], { params: { id } });
      setState((s) => (s.kind === "ready" ? { ...s, publication } : s));
      setStatus(
        route === "publish"
          ? "Published."
          : "Unpublished. The page and badge now read “withdrawn”.",
      );
    } catch (e) {
      setError(
        e instanceof ApiClientError && (e.status === 409 || e.status === 503)
          ? apiErrorMessage(e)
          : `Couldn’t ${route}. ${apiErrorMessage(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string, what: string) {
    setStatus(
      (await copy(text)) ? `Copied ${what}.` : `Couldn’t copy. Select the text and copy it.`,
    );
  }

  if (state.kind === "loading") return null;
  if (state.kind === "error")
    return (
      <section className={styles.share} aria-labelledby="share-h" data-testid="share-panel">
        <h2 id="share-h" className={styles.shareTitle}>
          Share this result
        </h2>
        <p className={styles.shareError} role="alert">
          {state.message}
        </p>
      </section>
    );

  const pub = state.publication;
  const live = pub?.status === "live";
  const origin = pub ? new URL(pub.page_url).origin : undefined;
  const delivered = state.runState === "delivered";
  // Only a delivered run can be shared; a published one keeps its panel to manage it.
  if (!delivered && !pub) return null;

  return (
    <section className={styles.share} aria-labelledby="share-h" data-testid="share-panel">
      <div className={styles.shareHead}>
        <div>
          <h2 id="share-h" className={styles.shareTitle}>
            Share this result
          </h2>
          <p className={styles.shareSub}>
            {live
              ? "Anyone with the link can read the signed result and how it was evaluated. Transcripts and logs stay private."
              : pub
                ? `Unpublished on ${DATE.format(new Date(pub.withdrawn_at ?? pub.published_at))}. The link and badge read “withdrawn”.`
                : "Publishing freezes this report and its method into a signed public page. Anyone with the link can read it; transcripts and logs stay private. You can unpublish it at any time."}
          </p>
        </div>
        {!live ? (
          <button
            type="button"
            className={styles.shareBtn}
            disabled={busy || !delivered}
            onClick={() => void act("publish")}
            data-testid="share-publish"
          >
            {busy ? "Publishing…" : pub ? "Publish again" : "Publish"}
          </button>
        ) : null}
      </div>

      {live && pub ? (
        <>
          <div className={styles.shareLink}>
            <input
              readOnly
              value={pub.page_url}
              aria-label="Public link"
              onFocus={(e) => e.currentTarget.select()}
              data-testid="share-url"
            />
            <button
              type="button"
              className={styles.shareBtn}
              onClick={() => void copyText(pub.page_url, "the link")}
            >
              Copy link
            </button>
          </div>
          <div className={styles.shareBadge}>
            <img src={pub.badge_url} alt={`anybench: ${pub.badge.message}`} height={20} />
            <span>v{pub.latest_version}</span>
          </div>
          <div className={styles.shareActions}>
            <button
              type="button"
              className={styles.shareBtnQuiet}
              onClick={() =>
                void copyText(
                  badgeMarkdown(pub.slug, pub.badge.message, origin),
                  "the badge Markdown",
                )
              }
            >
              Copy badge Markdown
            </button>
            <button
              type="button"
              className={styles.shareBtnQuiet}
              onClick={() =>
                void copyText(badgeHtml(pub.slug, pub.badge.message, origin), "the badge HTML")
              }
            >
              Copy badge HTML
            </button>
            <button
              type="button"
              className={styles.shareBtnQuiet}
              onClick={() =>
                void copyText(
                  embedHtml(pub.slug, heroSentence(pub.badge), origin),
                  "the embed code",
                )
              }
            >
              Copy embed code
            </button>
            <a
              className={styles.shareBtnQuiet}
              href={xIntentUrl(pub.badge, pub.page_url)}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="share-x"
            >
              Post to X
            </a>
            <a className={styles.shareBtnQuiet} href={pub.page_url} target="_blank" rel="noopener">
              Open page
            </a>
            <button
              type="button"
              className={styles.shareBtnQuiet}
              disabled={busy}
              onClick={() => void act("unpublish")}
              data-testid="share-unpublish"
            >
              Unpublish
            </button>
          </div>
        </>
      ) : null}
      {error ? (
        <p className={styles.shareError} role="alert">
          {error}
        </p>
      ) : null}
      <p className={styles.shareStatus} role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
