import type { Metadata } from "next";
import { DocsPage } from "../../../components/docs/DocsPage";
import { CodeBlock, StatusTag } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "Badges and embeds · Docs",
  description:
    "Put a signed Anybench result on your site and README: public benchmark page, SVG badge, iframe widget, oEmbed and verification.",
};

const BADGE_MD = `[![anybench](https://anybench.jaxonp.com/r/<slug>/badge.svg)](https://anybench.jaxonp.com/r/<slug>)`;

const EMBED_HTML = `<iframe src="https://anybench.jaxonp.com/r/<slug>/embed"
  title="Anybench: <result>" width="560" height="272"
  style="border:0;max-width:100%" loading="lazy"></iframe>`;

const VERIFY = `curl -s https://anybench.jaxonp.com/api/public/r/<slug>/attestation.json > a.json
curl -s https://anybench.jaxonp.com/api/.well-known/anybench-keys.json > keys.json`;

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
            contender versions, snapshot hashes, trial count, proof-check results, score, confidence
            interval and timestamp. Public keys are at <code>/.well-known/anybench-keys.json</code>.
          </li>
          <li>
            The public page lives at <code>anybench.jaxonp.com/r/&lt;slug&gt;</code>, an unguessable
            link, with the verdict, per-requirement and per-task charts with their confidence
            intervals, how it was evaluated and how to verify it. Transcripts are never public.
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
          An SVG at <code>/r/&lt;slug&gt;/badge.svg</code> (<code>?theme=dark</code> for dark
          pages), linked to the public page. It says &ldquo;better&rdquo; or &ldquo;worse&rdquo;
          only when the statistics did, and otherwise &ldquo;no detectable difference&rdquo;.
        </p>
        <CodeBlock label="README badge (Markdown)" code={BADGE_MD} />
      </section>

      <section aria-labelledby="badges-embed">
        <h2 id="badges-embed">Embed a benchmark</h2>
        <p>
          A compact card at <code>/r/&lt;slug&gt;/embed</code> with the verdict, its scope and the
          setups. It links to the full public page, and reads &ldquo;withdrawn&rdquo; if the owner
          unpublishes it. <code>?theme=light</code> or <code>dark</code>; the default follows the
          reader&rsquo;s system theme.
        </p>
        <CodeBlock label="Embed (HTML)" code={EMBED_HTML} />
        <p>
          GitHub READMEs strip iframes, so use the badge there and embed the card on your site,
          blog or docs. The page also has an oEmbed endpoint, so tools that support oEmbed unfurl
          the link.
        </p>
      </section>

      <section aria-labelledby="badges-og">
        <h2 id="badges-og">Link previews</h2>
        <p>Every published benchmark gets its own preview image for X, LinkedIn and Slack.</p>
      </section>

      <section aria-labelledby="badges-verify">
        <h2 id="badges-verify">Verify a result</h2>
        <p>The public page checks the signature for every visitor. To check it yourself:</p>
        <CodeBlock label="Fetch the signed snapshot and keys" code={VERIFY} />
        <p>
          Then verify the Ed25519 signature over the canonical JSON of <code>payload</code>; the
          public page shows a short script that does it.
        </p>
      </section>

      <section aria-labelledby="badges-current">
        <h2 id="badges-current">Staying current</h2>
        <p>
          &ldquo;Rerun on next release&rdquo; watches your GitHub releases and reruns the saved kit.
          The benchmark gets a new version, and if the new version is worse you are alerted before
          it goes public, unless you chose auto-publish. You also see views and clicks for each
          badge and embed.
        </p>
      </section>
    </DocsPage>
  );
}
