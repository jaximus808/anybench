// The Anybench MCP server (TDM-220 [19.4]): kit-authoring tools that run on the user's machine
// (guide, scaffold, validate, local proof) and API tools that push a kit, start a run from it and
// follow the run. The tools are exactly MCP_TOOLS (@anybench/core mcp-tools.ts), which the web
// docs render. API tools call the HTTP API through the typed core client (apiFromEnv, shared with
// apps/cli), authenticated by ANYBENCH_API_KEY; the key is never written to a result or a log.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ApiClientError,
  KitIdSchema,
  MCP_SERVER_NAME,
  MCP_TOOLS,
  PAGE_LIMIT_MAX,
  RUN_HOLD_STATES,
  RUN_TERMINAL_STATES,
  RunIdSchema,
  RunStateSchema,
  TrialIdSchema,
  TrialStateSchema,
  apiFromEnv,
  describeApiError,
  parseUsdBudget,
  redact,
  toJsonValue,
  type EnvApi,
  type FetchLike,
  type McpToolName,
  type RunState,
} from "@anybench/core";
import {
  DEFAULT_LOCAL_PROOF_IMAGE,
  KIT_TEMPLATES,
  KitScaffoldError,
  formatKitIssue,
  pushKit,
  runLocalProof,
  scaffoldKit,
  validateKitDir,
  type LocalProofResult,
} from "@anybench/kit";
import { z } from "zod";
import { kitGuide } from "./guide.js";

export const MCP_SERVER_VERSION = "0.1.0";

/** watch_run stops at these by default: the run needs you (Go, a question, a budget) or it ended. */
export const WATCH_DEFAULT_UNTIL: readonly RunState[] = [
  "awaiting_go",
  ...RUN_HOLD_STATES,
  ...RUN_TERMINAL_STATES,
];
export const WATCH_DEFAULT_TIMEOUT_S = 120;
export const WATCH_MAX_TIMEOUT_S = 600;
export const WATCH_POLL_MS = 5_000;
/** Lines of container log kept per failing proof unit in run_local_proof's result. */
export const PROOF_LOG_TAIL_LINES = 15;

export interface AnybenchMcpDeps {
  /** Default process.env. ANYBENCH_API_KEY, ANYBENCH_API_URL, ANYBENCH_WEB_URL, ANYBENCH_PROOF_IMAGE. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The API's fetch (tests: a fake API). */
  fetch?: FetchLike;
  /** Relative `dir` arguments resolve against this. Default process.cwd(). */
  cwd?: string;
  /** Tests stub the Docker proof. */
  runLocalProof?: typeof runLocalProof;
  /** watch_run's poll interval. */
  pollMs?: number;
}

type ToolResult = CallToolResult;

const DirSchema = z
  .string()
  .trim()
  .min(1)
  .describe("The kit folder: an absolute path, or relative to the server's working directory");

/** One tool's MCP description: the catalog sentence plus what it needs. */
function describeTool(name: McpToolName, extra = ""): string {
  const t = MCP_TOOLS.find((x) => x.name === name)!;
  const needs =
    t.scope === "local"
      ? "Runs locally; needs no API key."
      : `Needs ANYBENCH_API_KEY with scope ${t.scope}.`;
  return [t.does, extra, needs].filter((s) => s !== "").join(" ");
}

export function createAnybenchMcpServer(deps: AnybenchMcpDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const pollMs = deps.pollMs ?? WATCH_POLL_MS;
  const proof = deps.runLocalProof ?? runLocalProof;
  const resolveDir = (dir: string) => path.resolve(cwd, dir);

  // Belt and braces: whatever a result carries, the API key never leaves in it.
  const scrub = (text: string) => redact(text, { ANYBENCH_API_KEY: env.ANYBENCH_API_KEY });
  const ok = (value: unknown): ToolResult => ({
    content: [
      {
        type: "text",
        text: scrub(
          typeof value === "string" ? value : JSON.stringify(toJsonValue(value), null, 2),
        ),
      },
    ],
  });
  const fail = (lines: readonly string[]): ToolResult => ({
    isError: true,
    content: [{ type: "text", text: scrub(lines.join("\n")) }],
  });

  /** Run `fn` with the env's API client; a missing key or an API error becomes a tool error. */
  async function withApi(fn: (api: EnvApi) => Promise<ToolResult>): Promise<ToolResult> {
    const api = apiFromEnv({ env, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    if ("error" in api) return fail([api.error]);
    try {
      return await fn(api);
    } catch (e) {
      return fail(describeApiError(e));
    }
  }

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "Anybench turns a project into a benchmark. To build an eval kit: call get_kit_guide first, then scaffold_kit, edit the files, validate_kit until ok, run_local_proof until it passes, push_kit, and start_run with the kit_id. Follow runs with watch_run, get_run, list_trials, get_trial and get_report. Money is integer micro-USD.",
    },
  );

  // ------------------------------------------------------------------------------------------
  // Kit authoring (local)

  server.registerTool(
    "get_kit_guide",
    {
      title: "Kit guide",
      description: describeTool("get_kit_guide", "Read it before writing or changing a kit."),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok(kitGuide()),
  );

  server.registerTool(
    "scaffold_kit",
    {
      title: "Scaffold a kit",
      description: describeTool("scaffold_kit", "Refuses a non-empty folder unless force is true."),
      inputSchema: {
        dir: DirSchema,
        template: z
          .enum(KIT_TEMPLATES)
          .optional()
          .describe(`Which example to start from (default ${KIT_TEMPLATES[0]})`),
        force: z
          .boolean()
          .optional()
          .describe("Write into a non-empty folder (overwrites files with the same path)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ dir, template, force }) => {
      try {
        const r = await scaffoldKit(resolveDir(dir), {
          ...(template ? { template } : {}),
          force: force === true,
        });
        const v = await validateKitDir(r.dir);
        return ok({
          ok: v.ok,
          dir: r.dir,
          template: r.template,
          files: r.files,
          errors: v.lines,
          next: "edit anybench.yaml, workloads/, gates/ and proof/ into your own benchmark, then validate_kit",
        });
      } catch (e) {
        if (e instanceof KitScaffoldError) return fail([e.message]);
        throw e;
      }
    },
  );

  server.registerTool(
    "validate_kit",
    {
      title: "Validate a kit",
      description: describeTool("validate_kit"),
      inputSchema: { dir: DirSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ dir }) => {
      const r = await validateKitDir(resolveDir(dir));
      const k = r.kit;
      return ok({
        ok: r.ok,
        dir: r.dir,
        errors: r.lines,
        warnings: r.warnings.map(formatKitIssue),
        ...(k
          ? {
              kit: {
                subject: k.spec.subject.name,
                contenders: k.spec.contenders.map((c) => c.id),
                workloads: k.workloads.map((w) => ({
                  id: w.id,
                  sha256: w.sha256,
                  files: w.files.length,
                })),
                gates: k.spec.gates.map((g) => g.id),
                requirements: k.spec.requirements.map((q) => q.id),
              },
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "run_local_proof",
    {
      title: "Run the proof locally",
      description: describeTool(
        "run_local_proof",
        "Passes when the oracle passes every gate it covers and the untouched starting workspace fails a gate, on every workload. Needs Docker; takes from seconds to many minutes.",
      ),
      inputSchema: {
        dir: DirSchema,
        image: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            `Container image (default $ANYBENCH_PROOF_IMAGE or ${DEFAULT_LOCAL_PROOF_IMAGE})`,
          ),
        network: z.boolean().optional().describe("Give the containers a network (default: none)"),
        timeout_s: z
          .int()
          .min(1)
          .max(7_200)
          .optional()
          .describe("Overall cap in seconds (default 1800)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ dir, image, network, timeout_s }, extra) => {
      const log: string[] = [];
      const r = await proof(resolveDir(dir), {
        image: image ?? (env.ANYBENCH_PROOF_IMAGE || DEFAULT_LOCAL_PROOF_IMAGE),
        network: network === true,
        ...(timeout_s !== undefined ? { timeoutMs: timeout_s * 1000 } : {}),
        signal: extra.signal,
        onLog: (l) => {
          log.push(l);
          if (log.length > 200) log.shift();
        },
      });
      return ok(compactProof(r, log));
    },
  );

  // ------------------------------------------------------------------------------------------
  // Push and run (API, runs:write)

  server.registerTool(
    "push_kit",
    {
      title: "Push a kit",
      description: describeTool(
        "push_kit",
        "Run run_local_proof first to catch a broken oracle or gate for free.",
      ),
      inputSchema: { dir: DirSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ dir }) => {
      // The key is checked before anything is packed, like `anybench kit push`.
      return withApi(async (api) => {
        const log: string[] = [];
        const r = await pushKit(resolveDir(dir), api, { onLog: (l) => log.push(l) });
        if (!r.ok) {
          return fail([
            `push_kit stopped at ${r.stage}${r.stage === "validate" ? " (nothing uploaded)" : ""}:`,
            ...r.lines,
          ]);
        }
        return ok({
          ok: true,
          kit_id: r.kit.id,
          name: r.kit.name,
          version: r.kit.version,
          hash: r.kit.hash,
          proven: r.kit.proven,
          upload_id: r.upload_id,
          archive: r.archive,
          warnings: r.warnings,
          log,
          next: `start_run {kit_id: "${r.kit.id}", question, budget_usd}. Anybench reruns the six proof checks before any billed trial.`,
        });
      });
    },
  );

  server.registerTool(
    "start_run",
    {
      title: "Start a run",
      description: describeTool("start_run", "Give exactly one of budget_micro_usd or budget_usd."),
      inputSchema: {
        kit_id: KitIdSchema.describe("The kit_id push_kit returned"),
        question: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe(
            'What the run should answer, e.g. "Is my agent better than plain Claude Code?"',
          ),
        budget_micro_usd: z
          .union([z.int().positive(), z.string().regex(/^[1-9]\d{0,17}$/)])
          .optional()
          .describe("The most the run may spend, in integer micro-USD (1 USD = 1000000)"),
        budget_usd: z
          .string()
          .optional()
          .describe(
            'The most the run may spend, in US dollars as a decimal string: "25" or "12.50"',
          ),
        auto_go: z
          .boolean()
          .optional()
          .describe(
            "Start as soon as the estimate fits the budget (default: your account setting)",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ kit_id, question, budget_micro_usd, budget_usd, auto_go }) => {
      if ((budget_micro_usd === undefined) === (budget_usd === undefined)) {
        return fail(["give exactly one of budget_micro_usd or budget_usd"]);
      }
      let budget: bigint;
      if (budget_micro_usd !== undefined) {
        budget = BigInt(budget_micro_usd);
      } else {
        const b = parseUsdBudget(budget_usd!, "budget_usd");
        if (typeof b !== "bigint") return fail([b.error]);
        budget = b;
      }
      return withApi(async (api) => {
        const { run } = await api.client.runs.create({
          headers: { "idempotency-key": `mcp-${randomUUID()}` },
          body: {
            question,
            source: { kind: "kit", kit_id },
            budget_micro_usd: budget,
            ...(auto_go !== undefined ? { auto_go } : {}),
          },
        });
        return ok({
          run_id: run.id,
          state: run.state,
          kit_id,
          budget_micro_usd: run.budget_micro_usd,
          url: `${api.webUrl}/runs/${run.id}`,
          next: "watch_run to wait for awaiting_go (the proof reruns first), then Go on the run page",
        });
      });
    },
  );

  // ------------------------------------------------------------------------------------------
  // Observe (API, runs:read)

  const pageShape = {
    limit: z
      .int()
      .min(1)
      .max(PAGE_LIMIT_MAX)
      .optional()
      .describe(`Page size (max ${PAGE_LIMIT_MAX})`),
    cursor: z.string().min(1).optional().describe("next_cursor from the previous page"),
  };

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: describeTool("list_runs"),
      inputSchema: {
        state: z.array(RunStateSchema).min(1).optional().describe("Only runs in these states"),
        ...pageShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ state, limit, cursor }) =>
      withApi(async (api) =>
        ok(
          await api.client.runs.list({
            query: {
              ...(state ? { state } : {}),
              ...(limit !== undefined ? { limit } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "get_run",
    {
      title: "Get a run",
      description: describeTool("get_run"),
      inputSchema: { run_id: RunIdSchema.describe("The run id (a UUID)") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ run_id }) =>
      withApi(async (api) => {
        const detail = await api.client.runs.get({ params: { id: run_id } });
        return ok({ ...detail, url: `${api.webUrl}/runs/${run_id}` });
      }),
  );

  server.registerTool(
    "watch_run",
    {
      title: "Watch a run",
      description: describeTool(
        "watch_run",
        `Polls every ${Math.round(pollMs / 1000)} s. Default until: ${WATCH_DEFAULT_UNTIL.join(", ")}.`,
      ),
      inputSchema: {
        run_id: RunIdSchema.describe("The run id (a UUID)"),
        until: z
          .array(RunStateSchema)
          .min(1)
          .optional()
          .describe("Return when the run is in one of these states"),
        timeout_s: z
          .int()
          .min(1)
          .max(WATCH_MAX_TIMEOUT_S)
          .optional()
          .describe(
            `Give up after this many seconds (default ${WATCH_DEFAULT_TIMEOUT_S}, max ${WATCH_MAX_TIMEOUT_S})`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ run_id, until, timeout_s }, extra) =>
      withApi(async (api) => {
        const targets = new Set<RunState>(until ?? WATCH_DEFAULT_UNTIL);
        const deadline = Date.now() + (timeout_s ?? WATCH_DEFAULT_TIMEOUT_S) * 1000;
        let polls = 0;
        for (;;) {
          const detail = await api.client.runs.get({ params: { id: run_id } });
          polls++;
          const state = detail.run.state;
          const ended = (RUN_TERMINAL_STATES as readonly RunState[]).includes(state);
          const remaining = deadline - Date.now();
          if (targets.has(state) || ended || remaining <= 0 || extra.signal.aborted) {
            return ok({
              reached: targets.has(state),
              state,
              ...(ended && !targets.has(state) ? { ended: true } : {}),
              ...(remaining <= 0 && !targets.has(state) && !ended ? { timed_out: true } : {}),
              polls,
              run: detail.run,
              counters: detail.counters,
              open_alerts: detail.open_alerts,
              url: `${api.webUrl}/runs/${run_id}`,
            });
          }
          await sleep(Math.min(pollMs, remaining), extra.signal);
        }
      }),
  );

  server.registerTool(
    "list_trials",
    {
      title: "List a run's trials",
      description: describeTool("list_trials"),
      inputSchema: {
        run_id: RunIdSchema.describe("The run id (a UUID)"),
        state: z.array(TrialStateSchema).min(1).optional().describe("Only trials in these states"),
        ...pageShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ run_id, state, limit, cursor }) =>
      withApi(async (api) =>
        ok(
          await api.client.trials.list({
            params: { id: run_id },
            query: {
              ...(state ? { state } : {}),
              ...(limit !== undefined ? { limit } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "get_trial",
    {
      title: "Get a trial",
      description: describeTool(
        "get_trial",
        "Metrics count toward a score only when the gate passed.",
      ),
      inputSchema: { trial_id: TrialIdSchema.describe("The trial id (a UUID), from list_trials") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ trial_id }) =>
      withApi(async (api) => ok(await api.client.trials.get({ params: { id: trial_id } }))),
  );

  server.registerTool(
    "get_report",
    {
      title: "Get a run's report",
      description: describeTool("get_report", "Not there until the run has reached analyzing."),
      inputSchema: {
        run_id: RunIdSchema.describe("The run id (a UUID)"),
        format: z.enum(["markdown", "json"]).optional().describe("Default markdown"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ run_id, format }) =>
      withApi(async (api) => {
        try {
          if (format === "json")
            return ok(await api.client.reports.get({ params: { id: run_id } }));
          return ok(await api.client.reports.markdown({ params: { id: run_id } }));
        } catch (e) {
          if (e instanceof ApiClientError && e.status === 404) {
            return fail([
              `no report for run ${run_id} yet: it is written in analyzing (watch_run until delivered)`,
            ]);
          }
          throw e;
        }
      }),
  );

  return server;
}

/** run_local_proof's result: the checks and verdicts, each failing unit's log tail, no full logs. */
export function compactProof(r: LocalProofResult, log: readonly string[]) {
  const tail = (s: string) => s.trimEnd().split("\n").slice(-PROOF_LOG_TAIL_LINES);
  return {
    ok: r.ok,
    status: r.status,
    error: r.error,
    dir: r.dir,
    image: r.image,
    duration_s: Math.round(r.durationMs / 100) / 10,
    checks: r.checks.map((c) => ({
      check: c.check,
      pass: c.pass,
      reason: c.reason,
      units: c.units.map((u) => ({
        variant: u.variant,
        workload: u.workloadId,
        ok: u.ok,
        reason: u.reason,
        gates: u.gates.map((g) => ({
          gate: g.gateId,
          status: g.status,
          reason: g.reason.split("\n")[0],
          ...(g.status === "no_verdict" && g.log.trim() !== "" ? { log_tail: tail(g.log) } : {}),
        })),
        ...(!u.ok && u.log.trim() !== "" ? { log_tail: tail(u.log) } : {}),
      })),
    })),
    progress: log.slice(-30),
    next: r.ok
      ? "push_kit to upload it; Anybench reruns all six proof checks on its own computers"
      : "fix the kit (see the failing check's units and log tails), then run_local_proof again",
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
