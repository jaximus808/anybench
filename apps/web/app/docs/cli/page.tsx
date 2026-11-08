import type { Metadata } from "next";
import { DocsPage } from "../../../components/docs/DocsPage";
import { CodeBlock, StatusTag, type FeatureStatus, TableWrap } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "CLI · Docs",
  description:
    "The anybench command line: validate kits, start and watch runs, read logs, publish and verify results.",
};

const COMMANDS: readonly { usage: string; does: string; status: FeatureStatus }[] = [
  {
    usage: "anybench kit validate [dir] [--json] [--quiet]",
    does: "Validate a kit: anybench.yaml against KitSpec v2, every file it references, and the workload hashes. Exit 0 valid, 1 errors, 2 usage.",
    status: "available",
  },
  {
    usage: "anybench login",
    does: "Sign in with GitHub and store an API key for this machine.",
    status: "coming-soon",
  },
  {
    usage: "anybench init",
    does: "Start a kit for the current repo, or bundle a local .claude/ setup.",
    status: "coming-soon",
  },
  {
    usage: "anybench run",
    does: "Start a run from a kit or a question, show the test plan and the estimate, then Go.",
    status: "coming-soon",
  },
  {
    usage: "anybench watch <run>",
    does: "Live counters and the activity feed in your terminal.",
    status: "coming-soon",
  },
  {
    usage: "anybench logs <trial> -f",
    does: "Tail a trial's log as it runs.",
    status: "coming-soon",
  },
  {
    usage: "anybench report <run>",
    does: "Print the report as Markdown or JSON.",
    status: "coming-soon",
  },
  {
    usage: "anybench publish <run>",
    does: "Publish a delivered run as a signed benchmark and print the badge and embed snippets.",
    status: "coming-soon",
  },
  {
    usage: "anybench verify <url>",
    does: "Check a published benchmark's Ed25519 signature against the public keys.",
    status: "coming-soon",
  },
];

const VALIDATE_EXAMPLE = `$ anybench kit validate kits/my-kit
$ anybench kit validate kits/my-kit --json   # full result as JSON`;

export default function CliDocsPage() {
  return (
    <DocsPage
      path="/docs/cli"
      title="CLI"
      lede="The anybench command line runs the same API as the web app, so you can start, watch and publish benchmarks from a terminal or a CI job."
    >
      <section aria-labelledby="cli-install">
        <h2 id="cli-install">
          Install <StatusTag status="coming-soon" />
        </h2>
        <p>
          The CLI is not published to npm yet. Until it is, <code>anybench kit validate</code>{" "}
          runs from a checkout of the Anybench repository.
        </p>
        <CodeBlock label="Validate a kit" code={VALIDATE_EXAMPLE} />
      </section>

      <section aria-labelledby="cli-commands">
        <h2 id="cli-commands">Commands</h2>
        <TableWrap>
          <table>
            <caption>anybench commands</caption>
            <thead>
              <tr>
                <th scope="col">Command</th>
                <th scope="col">What it does</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {COMMANDS.map((c) => (
                <tr key={c.usage}>
                  <th scope="row">
                    <code>{c.usage}</code>
                  </th>
                  <td>{c.does}</td>
                  <td>
                    <StatusTag status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section aria-labelledby="cli-keys">
        <h2 id="cli-keys">API keys</h2>
        <p>
          The CLI authenticates with an API key (<code>ab_live_…</code> or <code>ab_test_…</code>
          ). Keys are shown once, can be limited to scopes (<code>runs:read</code>,{" "}
          <code>events:read</code>, <code>logs:read</code>, <code>alerts:write</code>,{" "}
          <code>runs:write</code>, <code>publish:write</code>) and to specific runs, and are revocable.
          A page for managing keys in the web app is coming soon.
        </p>
      </section>

      <section aria-labelledby="cli-skill">
        <h2 id="cli-skill">
          The <code>/anybench</code> Claude Code skill <StatusTag status="coming-soon" />
        </h2>
        <p>
          A Claude Code skill that bundles the repo you are in, or your <code>.claude/</code>{" "}
          setup, and starts a benchmark from inside Claude Code.
        </p>
      </section>
    </DocsPage>
  );
}
