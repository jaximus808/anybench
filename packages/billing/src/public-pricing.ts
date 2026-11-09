// The public pricing page's numbers (TDM-226, E20). GET /billing/pricing answers publicPricingFigures(...)
// with the server's billing config, and apps/web/app/(marketing)/pricing renders it, so every rate
// and both worked examples come from the same code that bills runs: estimateRunCost for the price,
// isStarterRun for "free". Nothing here reads a database; the page's live open/paused line comes
// from GET /billing/free-pool (free-run.ts poolStatusFrom), which never says dollars.
//
// The two examples are FIXED kit specs, so the page shows the same runs every time:
//   starter       your agent vs plain Claude Code, 2 workloads, small: what the free run includes,
//                 on the user's own Anthropic key (BYOK), within every starter limit.
//   head_to_head  the README example: Claude Code solo vs Tandem x3, the same 3 tasks, 18 measured
//                 trials each, on Anybench's model tokens, priced at each trial's time cap.
// Bigint only, like the rest of the package.
import {
  KitSpecSchema,
  type KitSpec,
  type KitSpecInput,
  type MicroUsd,
  type PricingExample,
} from "@anybench/core";
import { z } from "zod";
import { estimateRunCost, type EstimatePricingInput, type RunCostEstimate } from "./estimate.js";
import {
  FreeRunConfigSchema,
  isStarterRun,
  kitSetupCount,
  kitTokenUse,
  type FreeRunConfigInput,
} from "./free-run.js";
import {
  BpsSchema,
  computeChargeMicroUsd,
  naiveBlockPriceMicroUsd,
  NAIVE_BLOCK_SECONDS,
  type MachineSize,
} from "./pricing.js";

/** The standard eval computer the page quotes a block price for (Naïve 2 vCPU / 4 GiB). */
export const STANDARD_MACHINE: MachineSize = { vcpu: 2, memory_gb: 4 };

const exampleSubject = (name: string, summary: string) => ({
  kind: "harness" as const,
  name,
  summary,
  better_means: ["more trials pass every hidden test", "finishes sooner"],
});

const exampleRequirements = [
  {
    id: "tests-pass",
    type: "measured" as const,
    title: "Hidden tests pass",
    metric: "gate_pass_rate",
    unit: "ratio",
    better: "higher" as const,
    gate_id: "hidden-tests",
  },
  {
    id: "wall",
    type: "measured" as const,
    title: "Wall-clock time",
    metric: "wall_s",
    unit: "s",
    better: "lower" as const,
    gate_id: "hidden-tests",
  },
];

function agentContender(
  id: string,
  role: "subject" | "baseline",
  type: "coding-agent" | "harness",
  tokenSource: "anthropic_key" | "naive_proxy",
  capSeconds: number,
  extraEnv: Record<string, string> = {},
) {
  return {
    id,
    role,
    source: { github: `example/${id}`, ref: "v1" },
    driver: {
      type,
      verbs: { run: "run {task} {workspace}" },
      model: "claude-opus-5-5",
      wall_clock_cap_s: capSeconds,
      env: { AB_TOKEN_SOURCE: tokenSource, ...extraEnv },
    },
  };
}

/** Starter: your agent vs plain Claude Code on 2 small tasks, 3 measured repeats, your own key. */
export const STARTER_EXAMPLE_KIT: KitSpecInput = {
  schema_version: 2,
  subject: exampleSubject("your-agent", "Your agent against plain Claude Code on two small tasks."),
  contenders: [
    agentContender("your-agent", "subject", "coding-agent", "anthropic_key", 900),
    agentContender("claude-code", "baseline", "coding-agent", "anthropic_key", 900),
  ],
  workloads: [
    { id: "fix-a-bug", timeout_s: 900 },
    { id: "add-a-feature", timeout_s: 900 },
  ],
  gates: [{ id: "hidden-tests", kind: "hidden-tests" }],
  requirements: exampleRequirements,
  proof: { oracle: { id: "reference", dir: "proof/oracle/" } },
  scoring: { weights: { "tests-pass": 70, wall: 30 } },
  repeats: 3,
  env: {
    profile: "agent-cc",
    resources: { vcpu: STANDARD_MACHINE.vcpu, memory_gb: STANDARD_MACHINE.memory_gb, disk_gb: 20 },
  },
} as KitSpecInput;

/**
 * Head-to-head: the README example (kits/tandem-vs-claude-code, cut to its two headline setups):
 * Claude Code solo vs Tandem x3, the same 3 tasks, 18 measured trials each (6 repeats x 3 tasks),
 * one warm-up per setup and task, on Anybench's model tokens, 4 vCPU / 8 GiB computers, every
 * trial priced at its 1-hour time cap like the real kit.
 */
export const HEAD_TO_HEAD_EXAMPLE_KIT: KitSpecInput = {
  schema_version: 2,
  subject: exampleSubject("tandem", "Tandem with 3 workers against plain Claude Code."),
  contenders: [
    agentContender("tandem-x3", "subject", "harness", "naive_proxy", 3600, {
      TANDEM_WORKERS: "3",
    }),
    agentContender("claude-code-solo", "baseline", "coding-agent", "naive_proxy", 3600),
  ],
  workloads: [
    { id: "todo-api", timeout_s: 3600 },
    { id: "auth-refactor", timeout_s: 3600 },
    { id: "bug-hunt", timeout_s: 2400 },
  ],
  gates: [{ id: "hidden-tests", kind: "hidden-tests" }],
  requirements: exampleRequirements,
  proof: { oracle: { id: "reference", dir: "proof/oracle/" } },
  scoring: { weights: { "tests-pass": 70, wall: 30 } },
  repeats: 6,
  human_in_loop: { kind: "tandem", policy: "auto" },
  env: { profile: "agent-cc", resources: { vcpu: 4, memory_gb: 8, disk_gb: 20 } },
} as KitSpecInput;

interface ExampleDef {
  id: PricingExample["id"];
  title: string;
  summary: string;
  kit: KitSpecInput;
}

export const PRICING_EXAMPLES: readonly ExampleDef[] = [
  {
    id: "starter",
    title: "A starter run",
    summary:
      "Your agent against plain Claude Code on two small tasks, three measured repeats each, on your own Anthropic key.",
    kit: STARTER_EXAMPLE_KIT,
  },
  {
    id: "head_to_head",
    title: "A full head-to-head",
    summary:
      "Tandem with 3 workers against plain Claude Code (the README example): the same three coding tasks, 18 graded trials each, on Anybench's model tokens.",
    kit: HEAD_TO_HEAD_EXAMPLE_KIT,
  },
];

/** The knobs publicPricingFigures needs: the estimate's pricing plus the free run's config. */
export const PublicPricingConfigSchema = z.object({
  runFeeMicroUsd: z.bigint().nonnegative(),
  uploadedKitRunFeeMicroUsd: z.bigint().nonnegative(),
  computeMarkupBps: BpsSchema,
  managedTokenMarkupBps: BpsSchema,
  defaultBlockPriceMicroUsd: z.bigint().nonnegative(),
});
export type PublicPricingConfig = z.input<typeof PublicPricingConfigSchema> & {
  freeRun: FreeRunConfigInput;
};

/** One worked example: the fixed kit's shape, and its estimate (estimateRunCost). */
export interface PricingExampleFigures {
  id: PricingExample["id"];
  title: string;
  summary: string;
  setups: number;
  workloads: number;
  repeats: number;
  /** Whose model tokens the contenders spend. */
  tokens: "own_key" | "managed";
  /** isStarterRun on the same estimate, for an account with its Anthropic key stored. */
  free: boolean;
  estimate: RunCostEstimate;
}

/**
 * Every number the pricing page shows, as bigint figures. apps/server maps it to the
 * PublicPricing contract (the JSON integer fields: bps and block counts) at the route.
 */
export interface PublicPricingFigures {
  rates: {
    runFeeMicroUsd: MicroUsd;
    uploadedKitRunFeeMicroUsd: MicroUsd;
    computeMarkupBps: bigint | number;
    managedTokenMarkupBps: bigint | number;
    blockSeconds: number;
    machine: MachineSize & { blockCostMicroUsd: MicroUsd; blockChargeMicroUsd: MicroUsd };
  };
  freeRun: {
    offered: boolean;
    maxSetups: number;
    maxTrials: number;
    computeCapMicroUsd: MicroUsd;
    minGithubAgeDays: number;
  };
  examples: PricingExampleFigures[];
}

function exampleFrom(
  def: ExampleDef,
  pricing: EstimatePricingInput,
  freeRun: FreeRunConfigInput,
): PricingExampleFigures {
  const kit: KitSpec = KitSpecSchema.parse(def.kit);
  const estimate = estimateRunCost(kit, pricing);
  const starter = isStarterRun(kit, estimate, {
    // An account that stored its Anthropic key: the free run's own requirement.
    byokProviders: ["anthropic"],
    config: freeRun,
  });
  return {
    id: def.id,
    title: def.title,
    summary: def.summary,
    setups: kitSetupCount(kit),
    workloads: kit.workloads.length,
    repeats: kit.repeats,
    tokens: kitTokenUse(kit).managed.length > 0 ? "managed" : "own_key",
    free: starter.starter,
    estimate,
  };
}

/** Every number the public pricing page shows, from the billing config. Pure. */
export function publicPricingFigures(configInput: PublicPricingConfig): PublicPricingFigures {
  const config = PublicPricingConfigSchema.parse(configInput);
  const freeRun = FreeRunConfigSchema.parse(configInput.freeRun);
  const pricing: EstimatePricingInput = {
    runFeeMicroUsd: config.runFeeMicroUsd,
    uploadedKitRunFeeMicroUsd: config.uploadedKitRunFeeMicroUsd,
    computeMarkupBps: config.computeMarkupBps,
    managedTokenMarkupBps: config.managedTokenMarkupBps,
    defaultBlockPriceMicroUsd: config.defaultBlockPriceMicroUsd,
  };
  const blockCost = naiveBlockPriceMicroUsd(STANDARD_MACHINE, NAIVE_BLOCK_SECONDS);
  return {
    rates: {
      runFeeMicroUsd: config.runFeeMicroUsd,
      uploadedKitRunFeeMicroUsd: config.uploadedKitRunFeeMicroUsd,
      computeMarkupBps: config.computeMarkupBps,
      managedTokenMarkupBps: config.managedTokenMarkupBps,
      blockSeconds: NAIVE_BLOCK_SECONDS,
      machine: {
        ...STANDARD_MACHINE,
        blockCostMicroUsd: blockCost,
        blockChargeMicroUsd: computeChargeMicroUsd(blockCost, config.computeMarkupBps),
      },
    },
    freeRun: {
      offered: freeRun.poolMicroUsd > 0n,
      maxSetups: freeRun.maxSetups,
      maxTrials: freeRun.maxTrials,
      computeCapMicroUsd: freeRun.capMicroUsd,
      minGithubAgeDays: freeRun.minGithubAgeDays,
    },
    examples: PRICING_EXAMPLES.map((d) => exampleFrom(d, pricing, freeRun)),
  };
}
