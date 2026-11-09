// `anybench run --kit <kit_id> --question … --budget …` (TDM-219 [19.3]): start a run from an
// uploaded kit (RunSource {kind: "kit"}) and print its URL. The run skips kit generation but never
// the proof: Anybench reruns all six proof checks on its own computers before any billed trial.
//
// `anybench run --repo <owner/repo> [--ref <ref>] --question … --budget …` (TDM-245): start a run
// on a GitHub repo (RunSource {kind: "github"}), as the web's New run form does; for
// jaximus808/tandem the question picks a curated kit (e.g. "harness league … n=5").
// `--no-auto-go` sends auto_go: false, so the run waits in awaiting_go for Go whatever the
// account's "start runs automatically" setting says.
//
// Exit codes: 0 run created · 1 the API refused it · 2 usage or missing API key.
import { randomUUID } from "node:crypto";
import {
  KitIdSchema,
  RunSourceSchema,
  formatUsd,
  parseUsdBudget as parseUsdBudgetCore,
  type RunSource,
} from "@anybench/core";
import { apiFromEnv, describeApiError, type ApiDeps } from "./api.js";
import { defaultIo, parseFlags, type CliIo } from "./args.js";

export const RUN_USAGE = `Usage: anybench run (--kit <kit_id> | --repo <owner/repo> [--ref <ref>]) --question <text> --budget <usd> [--byok-limit <usd>] [--auto-go | --no-auto-go] [--json]

Start a run from a kit you pushed (anybench kit push), or on a GitHub repo. Anybench proves the
kit, then waits for Go (or starts on its own with auto-go), runs the trials and writes the report.
Nothing is billed until Go.

Options:
  --kit <kit_id>      the kit id kit push printed
  --repo <owner/repo> a GitHub repo (or github.com URL) instead of a kit
  --ref <ref>         the repo's branch, tag or commit (with --repo; default: its default branch)
  --question <text>   what the run should answer, e.g. "Is my agent better than plain Claude Code?"
  --budget <usd>      the most the run may spend, in US dollars (e.g. 25 or 12.50)
  --byok-limit <usd>  the most its trials may spend on your own model key (the budget never counts
                      those tokens): no trial launches unless its token cap still fits
  --auto-go           start as soon as the estimate fits the budget (default: your account setting)
  --no-auto-go        always wait for Go in awaiting_go, whatever your account setting says
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
    booleans: ["auto-go", "no-auto-go", "json"],
    strings: ["kit", "repo", "ref", "question", "budget", "byok-limit"],
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
  const repo = a.strings.get("repo")?.trim();
  const ref = a.strings.get("ref")?.trim();
  const question = a.strings.get("question")?.trim();
  const budgetRaw = a.strings.get("budget");
  const conflict =
    kit !== undefined && repo !== undefined
      ? "give --kit or --repo, not both"
      : a.booleans.has("auto-go") && a.booleans.has("no-auto-go")
        ? "give --auto-go or --no-auto-go, not both"
        : ref !== undefined && repo === undefined
          ? "--ref goes with --repo"
          : null;
  if (conflict) {
    io.stderr(`anybench run: ${conflict}`);
    io.stderr(RUN_USAGE);
    return 2;
  }
  const missing = [
    kit === undefined && repo === undefined ? "--kit or --repo" : null,
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
  let source: RunSource;
  if (repo !== undefined) {
    const parsed = RunSourceSchema.safeParse({
      kind: "github",
      github: repo,
      ...(ref ? { ref } : {}),
    });
    if (!parsed.success) {
      io.stderr(`anybench run: '${repo}' is not a GitHub repo (owner/repo or a github.com URL)`);
      return 2;
    }
    source = parsed.data;
  } else {
    const kitId = KitIdSchema.safeParse(kit);
    if (!kitId.success) {
      io.stderr(`anybench run: '${kit}' is not a kit id`);
      return 2;
    }
    source = { kind: "kit", kit_id: kitId.data };
  }
  const budget = parseUsdBudget(budgetRaw!);
  if (typeof budget !== "bigint") {
    io.stderr(`anybench run: ${budget.error}`);
    return 2;
  }
  const byokRaw = a.strings.get("byok-limit");
  const byokLimit = byokRaw === undefined ? undefined : parseUsdBudgetCore(byokRaw, "--byok-limit");
  if (byokLimit !== undefined && typeof byokLimit !== "bigint") {
    io.stderr(`anybench run: ${byokLimit.error}`);
    return 2;
  }
  const autoGo = a.booleans.has("auto-go")
    ? true
    : a.booleans.has("no-auto-go")
      ? false
      : undefined;
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
        source,
        budget_micro_usd: budget,
        ...(byokLimit !== undefined ? { byok_token_limit_micro_usd: byokLimit } : {}),
        ...(autoGo !== undefined ? { auto_go: autoGo } : {}),
      },
    });
    const url = `${api.webUrl}/runs/${run.id}`;
    if (a.booleans.has("json")) {
      io.stdout(
        JSON.stringify(
          {
            run_id: run.id,
            state: run.state,
            ...(source.kind === "kit" ? { kit_id: source.kit_id } : {}),
            ...(source.kind === "github"
              ? { repo: source.github, ...(source.ref ? { ref: source.ref } : {}) }
              : {}),
            ...(autoGo !== undefined ? { auto_go: autoGo } : {}),
            budget_micro_usd: budget.toString(),
            ...(byokLimit !== undefined
              ? { byok_token_limit_micro_usd: byokLimit.toString() }
              : {}),
            url,
          },
          null,
          2,
        ),
      );
    } else {
      io.stderr(
        `run ${run.id} created (${run.state}), budget ${formatUsd(budget)}` +
          (byokLimit !== undefined ? `, BYOK token limit ${formatUsd(byokLimit)}` : ""),
      );
      io.stdout(url);
    }
    return 0;
  } catch (e) {
    for (const l of describeApiError(e)) io.stderr(`anybench run: ${l}`);
    return 1;
  }
}
