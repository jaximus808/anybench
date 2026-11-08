// `eval-approver --policy auto|llm-reviewer|human-sim`: the Tandem approver sidecar.
//
//   eval-approver --policy auto --tandem-url http://127.0.0.1:7891 --out "$EVAL_OUT" \
//     --code-file "$EVAL_OUT/tandem/canvas.env" --trial t1 --contender tandem &
//   . "$EVAL_OUT/tandem/canvas.env"      # TANDEM_CANVAS_CODE=...
//   ... run the harness ...
//   kill -TERM %1; wait                  # final tick, then approvals.summary.json
//
// Prints `TANDEM_CANVAS_CODE=<code>` on stdout once the canvas is ready. llm-reviewer runs the
// reviewer on Naïve and needs NAIVE_API_KEY plus --reviewer-model and --reviewer-agent-id.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createNaiveClientFromEnv } from "@anybench/naive";
import { z } from "zod";
import { ApproverConfigSchema } from "./config.js";
import { APPROVER_POLICIES, formatApprovalSummary } from "./events.js";
import { LeakGuard } from "./leak-guard.js";
import { naiveReviewer, type Reviewer } from "./reviewer.js";
import { createTandemApprover } from "./tandem.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Resolves when the sidecar should stop (SIGTERM in bin.ts). */
  stopSignal?: AbortSignal;
}

const ArgsSchema = z.object({
  policy: z.enum(APPROVER_POLICIES),
  "tandem-url": z.url(),
  "canvas-code": z.string().min(1).optional(),
  out: z.string().min(1).optional(),
  "code-file": z.string().min(1).optional(),
  trial: z.string().min(1).optional(),
  contender: z.string().min(1).optional(),
  "poll-ms": z.coerce.number().int().min(100).max(60_000).default(1000),
  "reviewer-model": z.string().min(1).optional(),
  "reviewer-name": z.string().min(1).optional(),
  "reviewer-agent-id": z.string().min(1).optional(),
  "review-budget-micro-usd": z
    .string()
    .regex(/^[1-9][0-9]*$/, "integer micro-USD")
    .transform((s) => BigInt(s))
    .optional(),
  "subject-model": z.array(z.string().min(1)).default([]),
  once: z.boolean().default(false),
});

const USAGE =
  "usage: eval-approver --policy auto|llm-reviewer|human-sim --tandem-url URL [--out DIR] [--code-file PATH] " +
  "[--canvas-code CODE] [--trial ID] [--contender ID] [--poll-ms N] [--once] " +
  "[--reviewer-model M --reviewer-agent-id ID --review-budget-micro-usd N --subject-model M...]";

export async function main(argv: string[], io: CliIo): Promise<number> {
  let args: z.infer<typeof ArgsSchema>;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        policy: { type: "string" },
        "tandem-url": { type: "string" },
        "canvas-code": { type: "string" },
        out: { type: "string" },
        "code-file": { type: "string" },
        trial: { type: "string" },
        contender: { type: "string" },
        "poll-ms": { type: "string" },
        "reviewer-model": { type: "string" },
        "reviewer-name": { type: "string" },
        "reviewer-agent-id": { type: "string" },
        "review-budget-micro-usd": { type: "string" },
        "subject-model": { type: "string", multiple: true },
        once: { type: "boolean" },
      },
      strict: true,
    });
    args = ArgsSchema.parse({ ...values, out: values.out ?? io.env.EVAL_OUT });
  } catch (e) {
    io.stderr(`eval-approver: ${e instanceof Error ? e.message : String(e)}`);
    io.stderr(USAGE);
    return 2;
  }

  const config = ApproverConfigSchema.parse({
    kind: "tandem",
    policy: args.policy,
    ...(args["reviewer-model"] ? { reviewer_model: args["reviewer-model"] } : {}),
    ...(args["reviewer-name"] ? { reviewer_name: args["reviewer-name"] } : {}),
  });
  const guard = new LeakGuard();
  let reviewer: Reviewer | undefined;
  if (config.policy === "llm-reviewer") {
    if (!args["reviewer-agent-id"] || !args["review-budget-micro-usd"] || !config.reviewer_model) {
      io.stderr(
        "eval-approver: llm-reviewer needs --reviewer-model, --reviewer-agent-id and --review-budget-micro-usd",
      );
      return 2;
    }
    reviewer = naiveReviewer({
      client: createNaiveClientFromEnv(io.env),
      agentId: args["reviewer-agent-id"],
      name: config.reviewer_name,
      budgetMicroUsd: args["review-budget-micro-usd"],
      guard,
    });
  }

  const approver = createTandemApprover({
    baseUrl: args["tandem-url"],
    config,
    outDir: args.out ?? null,
    guard,
    subjectModels: args["subject-model"],
    ...(reviewer ? { reviewer } : {}),
    ...(args["canvas-code"] ? { canvasCode: args["canvas-code"] } : {}),
    ...(args.trial ? { trialId: args.trial } : {}),
    ...(args.contender ? { contenderId: args.contender } : {}),
  });

  const { canvasCode } = await approver.prepare();
  const line = `TANDEM_CANVAS_CODE=${canvasCode}`;
  if (args["code-file"]) {
    mkdirSync(dirname(args["code-file"]), { recursive: true });
    writeFileSync(args["code-file"], line + "\n");
  }
  io.stdout(line);

  if (args.once) {
    await approver.tick();
  } else {
    const signal = io.stopSignal ?? new AbortController().signal;
    await approver.run({
      signal,
      pollMs: args["poll-ms"],
      onError: (e) =>
        io.stderr(`eval-approver: tick failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  }

  const summary = approver.summary();
  if (args.out)
    writeFileSync(
      join(args.out, "approvals.summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
  io.stderr(formatApprovalSummary(summary));
  return 0;
}
