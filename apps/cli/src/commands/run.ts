// `anybench run --kit <kit_id> --question … --budget …` (TDM-219 [19.3]): start a run from an
// uploaded kit (RunSource {kind: "kit"}) and print its URL. The run skips kit generation but never
// the proof: Anybench reruns all six proof checks on its own computers before any billed trial.
//
// Exit codes: 0 run created · 1 the API refused it · 2 usage or missing API key.
import { randomUUID } from "node:crypto";
import { KitIdSchema, formatUsd, parseUsdBudget as parseUsdBudgetCore } from "@anybench/core";
import { apiFromEnv, describeApiError, type ApiDeps } from "./api.js";
import { defaultIo, parseFlags, type CliIo } from "./args.js";

export const RUN_USAGE = `Usage: anybench run --kit <kit_id> --question <text> --budget <usd> [--auto-go] [--json]

Start a run from a kit you pushed (anybench kit push). Anybench reruns the kit's proof on its own
computers, then runs the trials and writes the report. Nothing is billed until Go.

Options:
  --kit <kit_id>      the kit id kit push printed
  --question <text>   what the run should answer, e.g. "Is my agent better than plain Claude Code?"
  --budget <usd>      the most the run may spend, in US dollars (e.g. 25 or 12.50)
  --auto-go           start as soon as the estimate fits the budget (default: your account setting)
  --json              print the created run as JSON
  -h, --help

Env: ANYBENCH_API_KEY (required, scope runs:write), ANYBENCH_API_URL, ANYBENCH_WEB_URL.`;

/** "25", "$12.50", "0.000001" → integer micro-USD (shared with the MCP server: @anybench/core). */
export function parseUsdBudget(s: string): bigint | { error: string } {
  return parseUsdBudgetCore(s, "--budget");
}

export async function runRun(
  argv: readonly string[],
  io: CliIo = defaultIo,
  deps: ApiDeps = {},
): Promise<number> {
  const a = parseFlags(argv, {
    booleans: ["auto-go", "json"],
    strings: ["kit", "question", "budget"],
    maxPositionals: 0,
  });
  if ("error" in a) {
    io.stderr(`anybench run: ${a.error}`);
    io.stderr(RUN_USAGE);
    return 2;
  }
  if (a.booleans.has("help")) {
    io.stdout(RUN_USAGE);
    return 0;
  }
  const kit = a.strings.get("kit");
  const question = a.strings.get("question")?.trim();
  const budgetRaw = a.strings.get("budget");
  const missing = [
    kit === undefined ? "--kit" : null,
    !question ? "--question" : null,
    budgetRaw === undefined ? "--budget" : null,
  ].filter((x) => x !== null);
  if (missing.length > 0) {
    io.stderr(
      `anybench run: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`,
    );
    io.stderr(RUN_USAGE);
    return 2;
  }
  const kitId = KitIdSchema.safeParse(kit);
  if (!kitId.success) {
    io.stderr(`anybench run: '${kit}' is not a kit id`);
    return 2;
  }
  const budget = parseUsdBudget(budgetRaw!);
  if (typeof budget !== "bigint") {
    io.stderr(`anybench run: ${budget.error}`);
    return 2;
  }
  const api = apiFromEnv(deps);
  if ("error" in api) {
    io.stderr(`anybench run: ${api.error}`);
    return 2;
  }
  try {
    const { run } = await api.client.runs.create({
      headers: { "idempotency-key": `cli-${randomUUID()}` },
      body: {
        question: question!,
        source: { kind: "kit", kit_id: kitId.data },
        budget_micro_usd: budget,
        ...(a.booleans.has("auto-go") ? { auto_go: true } : {}),
      },
    });
    const url = `${api.webUrl}/runs/${run.id}`;
    if (a.booleans.has("json")) {
      io.stdout(
        JSON.stringify(
          {
            run_id: run.id,
            state: run.state,
            kit_id: kitId.data,
            budget_micro_usd: budget.toString(),
            url,
          },
          null,
          2,
        ),
      );
    } else {
      io.stderr(`run ${run.id} created (${run.state}), budget ${formatUsd(budget)}`);
      io.stdout(url);
    }
    return 0;
  } catch (e) {
    for (const l of describeApiError(e)) io.stderr(`anybench run: ${l}`);
    return 1;
  }
}
