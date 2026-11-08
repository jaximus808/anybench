import type { Metadata } from "next";
import { DocsPage } from "../../../components/docs/DocsPage";
import { StatusTag, TableWrap } from "../../../components/docs/Notices";

export const metadata: Metadata = {
  title: "MCP tools · Docs",
  description:
    "The Anybench MCP server: tools an agent uses to look into running evals, read logs and transcripts, and act on alerts.",
};

const TOOLS: readonly { name: string; args: string; does: string; scope: string }[] = [
  { name: "list_runs", args: "", does: "Your runs, newest first.", scope: "runs:read" },
  {
    name: "get_run",
    args: "{run_id}",
    does: "A run with its counters and open alerts.",
    scope: "runs:read",
  },
  {
    name: "get_run_events",
    args: "{run_id, after_seq, types?}",
    does: "Events after a sequence number, optionally filtered by type.",
    scope: "events:read",
  },
  {
    name: "watch_run",
    args: "{run_id, until, timeout_s}",
    does: "Long-poll until the run reaches a state or the timeout passes.",
    scope: "events:read",
  },
  { name: "get_trial", args: "{trial_id}", does: "One trial: phase, metrics, gate result.", scope: "runs:read" },
  {
    name: "tail_trial_log",
    args: "{trial_id, offset, bytes}",
    does: "Read a trial's log from a byte offset.",
    scope: "logs:read",
  },
  {
    name: "get_transcript",
    args: "{trial_id | agent_session_id, format}",
    does: "A trial's or agent session's transcript.",
    scope: "logs:read",
  },
  {
    name: "get_computer",
    args: "{computer_id}",
    does: "An eval computer's status and owning trial.",
    scope: "runs:read",
  },
  { name: "list_alerts", args: "", does: "Open and recent alerts.", scope: "runs:read" },
  { name: "ack_alert", args: "{alert_id}", does: "Acknowledge an alert.", scope: "alerts:write" },
  { name: "cancel_run", args: "{run_id}", does: "Cancel a run.", scope: "runs:write" },
  {
    name: "answer_agent",
    args: "{agent_session_id, answer}",
    does: "Answer a pending question or tool confirmation from one of the run's agents.",
    scope: "runs:write",
  },
  { name: "get_report", args: "{run_id}", does: "The report as JSON or Markdown.", scope: "runs:read" },
];

export default function McpDocsPage() {
  return (
    <DocsPage
      path="/docs/mcp"
      title="MCP tools"
      lede="The Anybench MCP server lets an agent look into a running eval the same way you do on the live run page: counters, events, logs, transcripts and alerts."
    >
      <section aria-labelledby="mcp-status">
        <h2 id="mcp-status">
          Status <StatusTag status="planned" />
        </h2>
        <p>
          The MCP server is planned. It will run over stdio and over streamable HTTP at{" "}
          <code>/mcp</code> on the API, and every tool wraps a REST route, so anything an agent
          can see you can also see in the app. Tool names and arguments below may still change.
        </p>
      </section>

      <section aria-labelledby="mcp-tools">
        <h2 id="mcp-tools">Tools</h2>
        <TableWrap>
          <table>
            <caption>Planned MCP tools</caption>
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Arguments</th>
                <th scope="col">What it does</th>
                <th scope="col">Key scope</th>
              </tr>
            </thead>
            <tbody>
              {TOOLS.map((t) => (
                <tr key={t.name}>
                  <th scope="row">
                    <code>{t.name}</code>
                  </th>
                  <td>{t.args ? <code>{t.args}</code> : "—"}</td>
                  <td>{t.does}</td>
                  <td>
                    <code>{t.scope}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section aria-labelledby="mcp-auth">
        <h2 id="mcp-auth">Auth</h2>
        <p>
          The MCP server uses the same scoped API keys as the CLI. A key can be limited to
          specific runs, so you can hand a worker agent a read-only key for one run and nothing
          else. <code>cancel_run</code> and <code>answer_agent</code> need a write scope.
        </p>
      </section>
    </DocsPage>
  );
}
