import type { Metadata } from "next";
import Link from "next/link";
import { DocsPage } from "../../../components/docs/DocsPage";
import { MINIMAL_KIT_YAML } from "../../../components/docs/kit-example";
import { KIT_LAYERS, KIT_OTHER_FIELDS, driverRows } from "../../../components/docs/kit-reference";
import { CodeBlock, StatusTag, TableWrap } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "How a kit works · Docs",
  description:
    "The anybench.yaml eval kit: source plus seven wrapper layers (L1–L7), nine driver types, and a minimal example.",
};

const KIT_TREE = `my-kit/
  anybench.yaml
  adapters/<contender>/install.sh  healthcheck.sh  driver.sh
  workloads/<workload>/input/  instruction.md  setup.sh
  gates/<gate>/check.sh  reference/
  rubric.md
  proof/oracle/  proof/do_less/<id>/  proof/regression/<id>/`;

export default function KitsDocsPage() {
  const drivers = driverRows();
  return (
    <DocsPage
      path="/docs/kits"
      title="How a kit works"
      lede="An eval kit is the single entry point for all testing. Agents write it, it is saved as plain files a person can read and edit, and it reruns on the next release."
    >
      <section aria-labelledby="kits-files">
        <h2 id="kits-files">The files</h2>
        <p>
          A kit is a folder with an <code>anybench.yaml</code> at the top and the scripts and data
          it points to. Every subject is wrapped the same way, so the eval computers never need to
          know what the subject is.
        </p>
        <CodeBlock label="Kit folder layout" code={KIT_TREE} />
      </section>

      <section aria-labelledby="kits-layers">
        <h2 id="kits-layers">Source plus seven wrapper layers</h2>
        <p>
          L0 is the thing being tested. L1 to L7 wrap it: install it, drive it, feed it a
          workload, measure it, check it was right, review it, and prove the checks work.
        </p>
        <TableWrap>
          <table>
            <caption>Kit layers</caption>
            <thead>
              <tr>
                <th scope="col">Layer</th>
                <th scope="col">
                  <code>anybench.yaml</code> field
                </th>
                <th scope="col">Files</th>
                <th scope="col">Contract</th>
              </tr>
            </thead>
            <tbody>
              {KIT_LAYERS.map((l) => (
                <tr key={l.id}>
                  <th scope="row">
                    {l.id} {l.name}
                  </th>
                  <td>
                    <code>{l.field}</code>
                  </td>
                  <td>{l.files === "—" ? "—" : <code>{l.files}</code>}</td>
                  <td>{l.contract}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <h3>Other fields</h3>
        <ul>
          {KIT_OTHER_FIELDS.map((f) => (
            <li key={f.field}>
              <code>{f.field}</code>: {f.meaning}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="kits-rule">
        <h2 id="kits-rule">The rule, in the schema</h2>
        <p>
          Every <code>measured</code> requirement must name a <code>gate_id</code>, and the score
          only accepts metrics from trials whose gate passed. A kit whose measured gate has no
          oracle in <code>proof.oracle</code> does not validate. <code>reviewed</code>{" "}
          requirements are scored by a reviewer agent against <code>rubric.md</code> and may also
          be gated, for example to review only code whose tests pass.
        </p>
      </section>

      <section aria-labelledby="kits-drivers">
        <h2 id="kits-drivers">Driver types</h2>
        <p>
          <code>driver.type</code> says what kind of software the contender is. It picks the
          computer profile and the default collectors, and the gate kinds that fit it.
        </p>
        <TableWrap>
          <table>
            <caption>The {drivers.length} driver types</caption>
            <thead>
              <tr>
                <th scope="col">
                  <code>driver.type</code>
                </th>
                <th scope="col">Class</th>
                <th scope="col">Driven by</th>
                <th scope="col">Measured</th>
                <th scope="col">Correctness gate</th>
                <th scope="col">Profile</th>
                <th scope="col">Default collectors</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.type}>
                  <th scope="row">
                    <code>{d.type}</code>
                    {d.roadmap && <StatusTag status="planned" />}
                  </th>
                  <td>{d.className}</td>
                  <td>{d.drivenBy}</td>
                  <td>{d.measured}</td>
                  <td>{d.gate}</td>
                  <td>
                    <code>{d.profile}</code>
                  </td>
                  <td>{d.collectors.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section aria-labelledby="kits-example">
        <h2 id="kits-example">A minimal kit</h2>
        <p>
          A CSV converter against csvkit: one workload, one output-diff gate, two measured
          requirements, and the three proof overlays. This exact file validates against KitSpec
          v2.
        </p>
        <CodeBlock label="anybench.yaml" code={MINIMAL_KIT_YAML} />
        <p>
          Check a kit locally with <code>anybench kit validate [dir]</code>
          <StatusTag status="available" />. It validates <code>anybench.yaml</code>, every file it
          references and the workload hashes. See the <Link href="/docs/cli">CLI</Link>.
        </p>
      </section>
    </DocsPage>
  );
}
