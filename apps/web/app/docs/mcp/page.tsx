import type { Metadata } from "next";
import { MCP_SETUP_COMMAND, MCP_TOOLS, type McpToolGroup } from "@anybench/core";
import { DocsPage } from "../../../components/docs/DocsPage";
import { CodeBlock, StatusTag, TableWrap } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "MCP tools · Docs",
  description:
    "The Anybench MCP server: tools your coding agent uses to build, prove and upload an eval kit, start a run from it, and follow the run to its report.",
};

// The tables render MCP_TOOLS (@anybench/core), the same catalog packages/mcp registers, so this
// page lists exactly the tools that exist (TDM-220).
const GROUPS: readonly { group: McpToolGroup; id: string; heading: string; caption: string }[] = [
  { group: "author", id: "mcp-author", heading: "Build and push a kit", caption: "Kit-authoring tools" },
  { group: "observe", id: "mcp-observe", heading: "Follow a run", caption: "Run tools" },
];

const CHECKOUT_EXAMPLE = `$ pnpm install && pnpm --filter "@anybench/mcp..." build
$ claude mcp add --scope user anybench -- node "$PWD/packages/mcp/dist/bin.js"
$ claude mcp list            # anybench: node …/bin.js - ✔ Connected`;

const FLOW_EXAMPLE = `get_kit_guide                      read the rules first
scaffold_kit {dir: "bench"}        start from an example
validate_kit {dir: "bench"}        until ok
run_local_proof {dir: "bench"}     oracle passes, do-nothing fails, in Docker
push_kit {dir: "bench"}            → kit_id
start_run {kit_id, question, budget_usd: "25"}
watch_run {run_id}                 → awaiting_go, then Go on the run page`;

export default function McpDocsPage() {
  return (
    <DocsPage
      path="/docs/mcp"
      title="MCP tools"
      lede="The Anybench MCP server lets your own coding agent build an eval kit on your machine, prove it locally for free, upload it, and start and follow a run from it."
    >
      <section aria-labelledby="mcp-status">
        <h2 id="mcp-status">
          Install <StatusTag status="available" />
        </h2>
        <p>
          The server runs over stdio. The npm package is not published yet; until it is, build it
          from a checkout of the Anybench repository and register it with Claude Code:
        </p>
        <CodeBlock label="From a checkout" code={CHECKOUT_EXAMPLE} />
        <p>
          Once it is on npm, <code>{MCP_SETUP_COMMAND}</code> registers it for every project (
          <code>claude mcp add --scope user anybench -- npx -y @anybench/mcp</code>), or prints that
          command when <code>claude</code> is not on your PATH.
        </p>
      </section>

      <section aria-labelledby="mcp-flow">
        <h2 id="mcp-flow">The flow</h2>
        <p>
          Kit generation runs on your agent and your tokens; Anybench bills only trial compute.
          Anybench reruns all six proof checks on its own computers before any billed trial: an
          uploaded kit is never trusted as is.
        </p>
        <CodeBlock label="A kit from scratch" code={FLOW_EXAMPLE} />
      </section>

      {GROUPS.map((g) => (
        <section key={g.group} aria-labelledby={g.id}>
          <h2 id={g.id}>{g.heading}</h2>
          <TableWrap>
            <table>
              <caption>{g.caption}</caption>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Arguments</th>
                  <th scope="col">What it does</th>
                  <th scope="col">Needs</th>
                </tr>
              </thead>
              <tbody>
                {MCP_TOOLS.filter((t) => t.group === g.group).map((t) => (
                  <tr key={t.name}>
                    <th scope="row">
                      <code>{t.name}</code>
                    </th>
                    <td>{t.args ? <code>{t.args}</code> : "—"}</td>
                    <td>{t.does}</td>
                    <td>{t.scope === "local" ? "nothing (runs locally)" : <code>{t.scope}</code>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </section>
      ))}

      <section aria-labelledby="mcp-auth">
        <h2 id="mcp-auth">Auth</h2>
        <p>
          The tools that call Anybench read an API key from <code>ANYBENCH_API_KEY</code> in the
          environment Claude Code starts the server in (<code>ANYBENCH_API_URL</code> points it at
          another API). <code>push_kit</code> and <code>start_run</code> need the{" "}
          <code>runs:write</code> scope; the run tools need <code>runs:read</code>. The
          kit-authoring tools run on your machine and need no key. The key is sent only as a
          request header and never appears in a tool result.
        </p>
        <p>
          Money is integer micro-USD everywhere: <code>start_run</code> takes{" "}
          <code>budget_micro_usd</code> as an integer, or <code>budget_usd</code> as a decimal
          string such as <code>&quot;12.50&quot;</code>. Nothing is billed until Go.
        </p>
      </section>
    </DocsPage>
  );
}
