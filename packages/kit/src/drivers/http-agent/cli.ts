// `anybench-http-agent`: the command an http-agent kit's driver.sh and check.sh call (TDM-40 [4.8]).
//
//   anybench-http-agent run  --in <EVAL_IN> --out <EVAL_OUT> [--config http-agent.json]
//                            [--endpoint URL] [--max-turns N] [--model ID] [--simulated-user naive]
//   anybench-http-agent gate --conversations <dir> --out <frozen EVAL_OUT> --verdict <gate.json>
//                            [--oracle <frozen oracle EVAL_OUT>]
//
// `run` exits 0 when every conversation completed, 1 when the agent failed a turn (transcripts
// are still written), 2 on a usage or configuration error. `gate` exits 0 once gate.json is
// written, whatever the verdict; the verdict is in the file.
import { parseArgs } from "node:util";
import { MicroUsdSchema } from "@anybench/core";
import { createNaiveClientFromEnv, ensureAgent } from "@anybench/naive";
import { loadHttpAgentConfig } from "./config.js";
import { loadConversationSet } from "./conversation.js";
import { runHttpAgentGate } from "./gate.js";
import { runConversationSet } from "./run.js";
import {
  naiveSimulatedUser,
  simulatedUserAgentSpec,
  type SimulatedUser,
} from "./simulated-user.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
}

const USAGE = `usage:
  anybench-http-agent run  --in DIR --out DIR [--config FILE] [--endpoint URL] [--max-turns N] [--model ID] [--simulated-user naive]
  anybench-http-agent gate --conversations DIR --out DIR --verdict FILE [--oracle DIR]`;

/** Monthly cap for the simulated-user agent we create on Naïve: $5. */
const SIM_USER_CAP_MICRO_USD = 5_000_000n;
/** Default per-turn budget for a simulated-user session: 2 cents. */
const SIM_USER_TURN_BUDGET_MICRO_USD = 20_000n;

async function naiveUserFromEnv(env: CliIo["env"]): Promise<SimulatedUser> {
  const model = env.ANYBENCH_SIMULATED_USER_MODEL;
  if (!model) throw new Error("--simulated-user naive needs ANYBENCH_SIMULATED_USER_MODEL");
  const budget = env.ANYBENCH_SIMULATED_USER_TURN_BUDGET_MICRO_USD
    ? MicroUsdSchema.parse(env.ANYBENCH_SIMULATED_USER_TURN_BUDGET_MICRO_USD)
    : SIM_USER_TURN_BUDGET_MICRO_USD;
  const client = createNaiveClientFromEnv(env);
  const { agent } = await ensureAgent(
    client,
    simulatedUserAgentSpec({ model, capMicroUsd: SIM_USER_CAP_MICRO_USD, maxTaskMicroUsd: budget }),
  );
  const keyPrefix = `${env.EVAL_TRIAL_ID ?? "local"}:${env.EVAL_ATTEMPT ?? "0"}`;
  return naiveSimulatedUser({ client, agentId: agent.id, turnBudgetMicroUsd: budget, keyPrefix });
}

export interface CliDeps {
  /** Overrides the Naïve-backed simulated user (tests pass a FakeNaive-backed one). */
  simulatedUser?: SimulatedUser;
  fetch?: typeof fetch;
}

export async function main(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "run") {
      const { values } = parseArgs({
        args: rest,
        options: {
          in: { type: "string" },
          out: { type: "string" },
          config: { type: "string" },
          endpoint: { type: "string" },
          "max-turns": { type: "string" },
          model: { type: "string" },
          "simulated-user": { type: "string" },
        },
        strict: true,
      });
      if (!values.in || !values.out) throw new UsageError("run needs --in and --out");
      const maxTurns = values["max-turns"] === undefined ? undefined : Number(values["max-turns"]);
      if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0))
        throw new UsageError("--max-turns must be a positive integer");
      const sim = values["simulated-user"];
      if (sim !== undefined && sim !== "naive")
        throw new UsageError("--simulated-user takes 'naive'");
      const config = await loadHttpAgentConfig(values.config);
      const conversations = await loadConversationSet(values.in);
      const simulatedUser =
        sim === undefined ? undefined : (deps.simulatedUser ?? (await naiveUserFromEnv(io.env)));
      const endpoint = values.endpoint ?? io.env.HTTP_AGENT_ENDPOINT;
      const r = await runConversationSet({
        conversations,
        config,
        outDir: values.out,
        env: io.env,
        ...(endpoint ? { endpoint } : {}),
        ...(simulatedUser ? { simulatedUser } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      for (const t of r.transcripts)
        io.stdout(
          `${t.conversation_id}: ${t.status} (${t.turns.length} turn(s), ended by ${t.ended_by})${t.error ? `: ${t.error}` : ""}`,
        );
      return r.ok ? 0 : 1;
    }
    if (cmd === "gate") {
      const { values } = parseArgs({
        args: rest,
        options: {
          conversations: { type: "string" },
          out: { type: "string" },
          verdict: { type: "string" },
          oracle: { type: "string" },
        },
        strict: true,
      });
      if (!values.conversations || !values.out || !values.verdict)
        throw new UsageError("gate needs --conversations, --out and --verdict");
      const { gate } = await runHttpAgentGate({
        conversationsDir: values.conversations,
        outDir: values.out,
        verdictPath: values.verdict,
        ...(values.oracle ? { oracleOutDir: values.oracle } : {}),
      });
      io.stdout(`${gate.pass ? "PASS" : "FAIL"}: ${gate.reason}`);
      return 0;
    }
    throw new UsageError(cmd === undefined ? "missing command" : `unknown command '${cmd}'`);
  } catch (e) {
    io.stderr(`anybench-http-agent: ${(e as Error).message}`);
    if (e instanceof UsageError) io.stderr(USAGE);
    return 2;
  }
}

class UsageError extends Error {}
