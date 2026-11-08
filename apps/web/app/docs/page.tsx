import type { Metadata } from "next";
import Link from "next/link";
import { DocsPage } from "../../components/docs/DocsPage";
import { Callout, TableWrap } from "../../components/docs/Notices";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How Anybench turns any project into a benchmark: eval kits, eval computers, proof checks, the CLI, MCP tools and publishing.",
};

const STEPS: readonly { name: string; body: string }[] = [
  {
    name: "Ask",
    body: "Point Anybench at a GitHub repo, a binary with its docs, or a Claude Code setup, and say what you want to know (“is my harness better than plain Claude Code?”).",
  },
  {
    name: "Test plan",
    body: "Agents work out what the project does, find what it should be compared against, and write an eval kit. You see every contender, what will be measured, the gate each number must pass, and the cost estimate. Edit anything, then press Go.",
  },
  {
    name: "Running",
    body: "The kit runs on cloud computers built for this eval. Contenders are interleaved on the same machine profile, warm-ups are discarded, and you can watch every trial live.",
  },
  {
    name: "Results",
    body: "A score for each contender, a per-requirement breakdown, where each one breaks, the bottlenecks behind the numbers, and the proof that the test was fair.",
  },
  {
    name: "Publish",
    body: "Freeze the report into a signed version with a public page, a badge and an embeddable widget.",
  },
];

export default function DocsOverviewPage() {
  return (
    <DocsPage
      path="/docs"
      title="Anybench docs"
      lede="Anybench turns any project (an agent, a harness, or any other software) into a benchmark. Agents write the eval kit, eval computers run it, and the report says whether it's better and why."
    >
      <section aria-labelledby="overview-flow">
        <h2 id="overview-flow">How a run goes</h2>
        <ol>
          {STEPS.map((s) => (
            <li key={s.name}>
              <strong>{s.name}.</strong> {s.body}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="overview-rule">
        <h2 id="overview-rule">The one rule</h2>
        <Callout>
          <p>
            <strong>No speed or quality number without a correctness gate.</strong> A fast answer
            that is wrong is not a result. Every measured requirement in a kit names a gate, the
            gate runs separately from the contender&rsquo;s trial, and a number only counts for
            trials whose gate passed. A kit that cannot prove its gate tells right from wrong is
            not run.
          </p>
        </Callout>
        <p>
          The <Link href="/docs/proof-checks">proof checks</Link> enforce this before any billed
          trial runs.
        </p>
      </section>

      <section aria-labelledby="overview-what">
        <h2 id="overview-what">What you can benchmark</h2>
        <ul>
          <li>
            <strong>Agents</strong>: coding agents and API or chat agents, scored on hidden tests
            or labeled answers, with tokens, turns, cost and time.
          </li>
          <li>
            <strong>Harnesses</strong>: setups that run several agents with approvals, like a task
            board with workers, compared against plain Claude Code.
          </li>
          <li>
            <strong>Software</strong>: CLIs, services, libraries, terminal emulators and web apps,
            measured on time, throughput and memory against the oracle&rsquo;s output.
          </li>
        </ul>
        <p>
          <Link href="/docs/kits">How a kit works</Link> lists every layer and driver type.
        </p>
      </section>

      <section aria-labelledby="overview-failures">
        <h2 id="overview-failures">When a trial fails</h2>
        <p>Every failed trial is put in one class, so you always know whose problem it was:</p>
        <TableWrap>
          <table>
            <caption>Failure classes</caption>
            <thead>
              <tr>
                <th scope="col">Class</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>infra</code>
                </td>
                <td>Our side failed. Retried automatically and never billed.</td>
              </tr>
              <tr>
                <td>
                  <code>subject</code>
                </td>
                <td>The contender failed the task.</td>
              </tr>
              <tr>
                <td>
                  <code>gate</code>
                </td>
                <td>The output did not match the reference.</td>
              </tr>
              <tr>
                <td>
                  <code>kit</code>
                </td>
                <td>Our grader or adapter was wrong.</td>
              </tr>
              <tr>
                <td>
                  <code>budget</code>
                </td>
                <td>The trial hit a token or spend cap.</td>
              </tr>
              <tr>
                <td>
                  <code>timeout</code>
                </td>
                <td>The trial ran past its wall-clock cap.</td>
              </tr>
            </tbody>
          </table>
        </TableWrap>
        <p>
          A run that ends failed or needing a person gets a written postmortem: which stage, which
          agent, which error.
        </p>
      </section>

      <section aria-labelledby="overview-more">
        <h2 id="overview-more">Use it from your tools</h2>
        <ul>
          <li>
            <Link href="/docs/cli">CLI</Link>: start, watch and publish runs from a terminal.
          </li>
          <li>
            <Link href="/docs/mcp">MCP tools</Link>: let an agent look into a running eval.
          </li>
          <li>
            <Link href="/docs/badges">Badges and embeds</Link>: put a signed result on your site
            and README.
          </li>
        </ul>
      </section>
    </DocsPage>
  );
}
