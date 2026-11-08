// TDM-170 part 2b: prove a Naïve agent session sees and calls the app's MCP tool.
// Usage: SPIKE_STATE=<file> ./run.sh agent.mjs models [search] | run <model> | delete
/* global process */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { naive, step, log } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STATE = process.env.SPIKE_STATE ?? join(here, ".state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const c = naive();
const [cmd, arg] = process.argv.slice(2);
const TOOL = "tdm170-spike.spike_echo";
// Variant: SPIKE_TOOLS=allow-all creates a second agent whose default permission is allow.
const ALLOW_ALL = process.env.SPIKE_TOOLS === "allow-all";
const agentKey = ALLOW_ALL ? "agentIdAllowAll" : "agentId";

switch (cmd) {
  case "models": {
    const page = await c.models.list({ search: arg, limit: 50 });
    log(
      "models.list",
      page.data.map((m) => ({
        id: m.id,
        ...(m.pricing ? { pricing: m.pricing } : {}),
        windows: m.supported_windows,
      })),
    );
    break;
  }
  case "run": {
    const agent = state[agentKey]
      ? { id: state[agentKey] }
      : await step(
          "agents.create",
          () =>
            c.agents.create({
              name: ALLOW_ALL ? "tdm170-mcp-probe-allow" : "tdm170-mcp-probe",
              model: arg,
              system:
                "You are a test probe. When asked, call the tool you are told to call exactly once and then reply with the tool's raw text output. Do nothing else.",
              budget: { cap_micro_usd: 500_000, max_task_micro_usd: 200_000, period: "month" },
              handoffs: false,
              tools: {
                default_config: { permission: ALLOW_ALL ? "allow" : "deny" },
                configs: {
                  [TOOL]: { enabled: true, permission: "allow" },
                  apps: {
                    enabled: true,
                    permission: "allow",
                    config: { allowed_apps: [state.appId] },
                  },
                },
              },
            }),
          { rethrow: true },
        );
    state[agentKey] = agent.id;
    save();
    const s = await step(
      "sessions.create",
      () =>
        c.sessions.create({
          agent_id: agent.id,
          budget_micro_usd: 100_000,
          message:
            process.env.SPIKE_PROMPT ??
            `List the tools you have whose names start with "tdm170-spike." and then call ${TOOL} with message "hello from TDM-170". Reply with the list of those tool names and the tool's raw output.`,
          metadata: { ticket: "TDM-170" },
        }),
      { rethrow: true },
    );
    state.sessionId = s.id;
    save();
    const seen = [];
    try {
      for await (const ev of c.stream(s.id)) {
        const t = ev.type;
        const brief = JSON.stringify(ev).slice(0, 600);
        if (!/delta/.test(t)) seen.push(brief);
        if (/tool|error|idle|terminated|status|budget/.test(t)) log(`event ${t}`, brief);
        if (t === "session.idle" || t === "budget.exceeded") break;
      }
    } catch (e) {
      log("stream error", String(e?.message ?? e));
    }
    await step("sessions.get", () => c.sessions.get(s.id));
    log("non-delta events (first 40)", seen.slice(0, 40));
    break;
  }
  case "delete":
    for (const k of ["agentId", "agentIdAllowAll"])
      if (state[k]) await step(`agents.delete ${k}`, () => c.agents.delete(state[k]));
    break;
  default:
    log("usage", "models [search] | run <model> | delete");
}
