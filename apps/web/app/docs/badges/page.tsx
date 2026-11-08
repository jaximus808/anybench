import type { Metadata } from "next";
import { DocsPage } from "../../../components/docs/DocsPage";
import { CodeBlock, StatusTag } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "Badges and embeds · Docs",
  description:
    "Put a signed Anybench result on your site and README: public benchmark page, SVG badge, iframe widget, oEmbed and verification.",
};

const BADGE_MD = `[![Anybench](https://api.anybench.jaxonp.com/badge/<slug>.svg?variant=verdict)](https://anybench.jaxonp.com/b/<owner>/<slug>)`;

const EMBED_HTML = `<iframe
  src="https://anybench.jaxonp.com/embed/<slug>?theme=auto"
  title="Anybench results for <slug>"
  width="100%" height="420" loading="lazy"></iframe>`;

const VERIFY = `$ anybench verify https://anybench.jaxonp.com/b/<owner>/<slug>`;

export default function BadgesDocsPage() {
  return (
    <DocsPage
      path="/docs/badges"
      title="Badges and embeds"
      lede="A published benchmark is a result you can put on your landing page, README and launch posts, and that a skeptic can verify."
    >
      <section aria-labelledby="badges-status">
        <h2 id="badges-status">
          Status <StatusTag status="planned" />
        </h2>
        <p>
          Publishing, badges and embeds are planned. URLs and query parameters below show the
          intended shape and may change before launch.
        </p>
      </section>

      <section aria-labelledby="badges-publish">
        <h2 id="badges-publish">Publishing</h2>
        <ul>
          <li>
            Only a delivered run whose proof checks all passed can be published, and it is always
            published whole: every contender, every workload, and where each one breaks.
          </li>
          <li>
            Publishing freezes the report into a version and signs it with Ed25519: kit hash,
            contender versions, snapshot hashes, trial count, proof-check results, score,
            confidence interval and timestamp. Public keys are at{" "}
            <code>/.well-known/anybench-keys.json</code>.
          </li>
          <li>
            The public page lives at <code>anybench.jaxonp.com/b/&lt;owner&gt;/&lt;slug&gt;</code>{" "}
            with the report, version history, the proof, &ldquo;Rerun this benchmark&rdquo; and
            &ldquo;Download the kit&rdquo;. Transcripts are never public.
          </li>
          <li>
            Public or unlisted. Unpublishing turns the badge into &ldquo;withdrawn&rdquo; rather
            than making it disappear.
          </li>
        </ul>
      </section>

      <section aria-labelledby="badges-badge">
        <h2 id="badges-badge">Badge</h2>
        <p>
          An SVG at <code>api.anybench.jaxonp.com/badge/&lt;slug&gt;.svg</code>, edge-cached and
          linked to the public page. Variants: <code>score</code>, <code>verdict</code> (for
          example &ldquo;beats Claude Code +13&rdquo;) and <code>rank</code>. It shows the latest
          version by default, or a version you pin.
        </p>
        <CodeBlock label="README badge (Markdown)" code={BADGE_MD} />
      </section>

      <section aria-labelledby="badges-embed">
        <h2 id="badges-embed">Embeddable widget</h2>
        <p>
          An iframe with the results table or chart, in light, dark or auto theme. It sizes itself
          to its content through <code>postMessage</code>. A script-tag loader and an oEmbed
          endpoint are planned too, so Notion, Ghost, Medium and others unfurl the link.
        </p>
        <CodeBlock label="Embed (HTML)" code={EMBED_HTML} />
      </section>

      <section aria-labelledby="badges-og">
        <h2 id="badges-og">Link previews</h2>
        <p>
          Every published benchmark gets its own preview image for X, LinkedIn and Slack.
        </p>
      </section>

      <section aria-labelledby="badges-verify">
        <h2 id="badges-verify">Verify a result</h2>
        <p>
          The public page checks the signature for every visitor. To check it yourself:
        </p>
        <CodeBlock label="Verify from the CLI" code={VERIFY} />
      </section>

      <section aria-labelledby="badges-current">
        <h2 id="badges-current">Staying current</h2>
        <p>
          &ldquo;Rerun on next release&rdquo; watches your GitHub releases and reruns the saved
          kit. The benchmark gets a new version, and if the new version is worse you are alerted
          before it goes public, unless you chose auto-publish. You also see views and clicks for
          each badge and embed.
        </p>
      </section>
    </DocsPage>
  );
}
