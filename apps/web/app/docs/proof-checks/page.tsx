import type { Metadata } from "next";
import { DocsPage } from "../../../components/docs/DocsPage";
import { TableWrap } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "Proof checks · Docs",
  description:
    "The six proof checks every kit must pass before a billed run: oracle, do-less, smoke, regression, baselines and no secrets.",
};

const PROOF_CHECKS: readonly { name: string; passes: string; why: string }[] = [
  {
    name: "Oracle passes",
    passes: "The reference solution passes every gate it covers at 100%.",
    why: "A gate that fails a known-good answer would punish correct contenders.",
  },
  {
    name: "Do-less fails",
    passes: "Each do-less variant, a version that skips work, fails the gate.",
    why: "A gate that a lazy contender can pass would reward cutting corners.",
  },
  {
    name: "Smoke run passes",
    passes: "One real trial on the real computer profile completes and produces outputs.",
    why: "Catches install, driver and environment mistakes before you pay for a full run.",
  },
  {
    name: "Planted regression scores lower",
    passes: "A deliberately worse version of a contender gets a lower score.",
    why: "Shows the measurement can actually see a difference.",
  },
  {
    name: "Known baselines land in range",
    passes: "Baselines with published numbers score where those numbers say they should.",
    why: "A kit that disagrees wildly with known results is probably measuring the wrong thing.",
  },
  {
    name: "No secret in the kit",
    passes: "No key, token or password in any kit file, by pattern and by exact value.",
    why: "Kits are saved, downloaded and published. Secrets go in secrets[] by name only.",
  },
];

export default function ProofChecksDocsPage() {
  return (
    <DocsPage
      path="/docs/proof-checks"
      title="Proof checks"
      lede="Before any billed run, a kit has to prove its own gates tell right from wrong. Six checks run automatically; if one fails, the kit designer repairs the kit and tries again."
    >
      <section aria-labelledby="proof-six">
        <h2 id="proof-six">The six checks</h2>
        <TableWrap>
          <table>
            <caption>Proof checks</caption>
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Passes when</th>
                <th scope="col">Why it matters</th>
              </tr>
            </thead>
            <tbody>
              {PROOF_CHECKS.map((c) => (
                <tr key={c.name}>
                  <th scope="row">{c.name}</th>
                  <td>{c.passes}</td>
                  <td>{c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section aria-labelledby="proof-overlays">
        <h2 id="proof-overlays">Overlays</h2>
        <p>
          The oracle, do-less and regression checks are written in the kit&rsquo;s{" "}
          <code>proof</code> section. Each is a contender overlay, a driver patch or a set of env
          vars, that runs through install, driver, workload, probes and gate exactly like a real
          contender. Do-less variants depend on the kind of software:
        </p>
        <ul>
          <li>Terminal emulator: a PTY shim that drops every Nth 64 KiB chunk.</li>
          <li>Coding agent: a CLAUDE.md that says &ldquo;skip the tests&rdquo;, or a 3-turn cap.</li>
          <li>Service: an API that returns cached responses.</li>
          <li>Harness: a no-op harness, which must fail the hidden tests and show 0 claims.</li>
        </ul>
      </section>

      <section aria-labelledby="proof-repair">
        <h2 id="proof-repair">When a check fails</h2>
        <p>
          A verifier agent explains the failure and the kit designer repairs the kit, up to 2
          times. If the kit still fails, the run stops at <code>needs_human</code> with the
          failing check and the explanation, and nothing is billed. The test plan shows the result
          of every check before you press Go.
        </p>
      </section>

      <section aria-labelledby="proof-published">
        <h2 id="proof-published">On published results</h2>
        <p>
          Only a delivered run whose proof checks all passed can be published, and the results of
          every check are part of the signed attestation, so anyone reading a badge can see the
          proof behind it.
        </p>
      </section>
    </DocsPage>
  );
}
