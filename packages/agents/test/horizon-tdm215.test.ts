// TDM-215 [18.8]: the understander judges the task horizon (with a rationale), the kit designer
// plans long-horizon workloads for a subject that coordinates agents, and code enforces the floor.
// Model answers are fixtures: no network, no spend.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  describesCoordination,
  isCoordinationSubject,
  KitHorizonPlanSchema,
  LONG_HORIZON_MIN_WALL_S,
  type ProjectDigest,
} from "@anybench/core";
import { RepoIngestSchema, type RepoContext, type RepoIngest } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  buildKitDesignerInput,
  decideUnderstanding,
  draftHorizonIssues,
  horizonRequirement,
  KIT_DESIGNER_ROLE,
  KitDesignerOutputSchema,
  loadRole,
  UNDERSTANDER_ROLE,
  UnderstanderOutputSchema,
  type KitDesignerUnderstanding,
  type UnderstanderOutput,
} from "../src/index.js";
import { TDM60_RG_DRAFT } from "../../kit/test/tdm60-generate-fixtures.js";

function fixtureTdm215(name: string): RepoIngest {
  const file = fileURLToPath(new URL(`../../kit/fixtures/digests/${name}.json`, import.meta.url));
  return RepoIngestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const TANDEM = fixtureTdm215("agentcanvas");
const HYPERFINE = fixtureTdm215("hyperfine");

/** A one-file Python CLI: `cli.py`, a console script, nothing else. */
function singleFileCliTdm215(): { digest: ProjectDigest; context: RepoContext } {
  return {
    digest: {
      ...HYPERFINE.digest,
      name: "csvcount",
      summary: "Count rows in CSV files",
      languages: [{ name: "Python", bytes: 3_000 }],
      entrypoints: [{ kind: "script", name: "csvcount" }],
      suggested_driver_types: ["cli"],
    },
    context: {
      ...HYPERFINE.context,
      tree: { paths: ["README.md", "cli.py"], dirs: [], truncated: false },
      readme: {
        path: "README.md",
        text: "# csvcount\n\n`python cli.py data.csv` prints the row count.\n",
        truncated: false,
      },
      manifests: [],
      recent_test_commits: [],
    },
  };
}

const TANDEM_RATIONALE =
  "Tandem exists to split work across parallel Claude Code sessions that claim tickets from one queue. That planning and handoff cost is paid on every task, and it only pays off when the task is big enough that one session would have to compact its context: a whole application across several feature areas. Three small tasks would measure the overhead and never the benefit.";

function tandemOutputTdm215(over: Partial<UnderstanderOutput> = {}): UnderstanderOutput {
  return UnderstanderOutputSchema.parse({
    kind: "harness",
    driver_type: "harness",
    driver_reason: "coordinates parallel Claude Code sessions through a task queue",
    summary:
      "A shared task queue where a planner splits work into tickets and parallel Claude Code workers claim them, with approvals.",
    better_means: ["pass@1 on hidden tests", "cost per solved task", "time to solve"],
    risks: ["needs a model API key"],
    benchable: "ready",
    reason: "runs on a Linux VM with Claude Code",
    claims: [],
    subject_command: null,
    history: { minable: true, why: "many fix + test commits" },
    labelled_conversations: null,
    horizon: { horizon: "long", rationale: TANDEM_RATIONALE },
    ...over,
  });
}

function cliOutputTdm215(over: Partial<UnderstanderOutput> = {}): UnderstanderOutput {
  return UnderstanderOutputSchema.parse({
    kind: "software",
    driver_type: "cli",
    driver_reason: "ships cli.py as a console script",
    summary: "A command-line tool that counts rows in CSV files.",
    better_means: ["lower warm wall time on the same output"],
    risks: [],
    benchable: "ready",
    reason: "a Python CLI that runs on Linux",
    claims: [],
    subject_command: {
      binary: "csvcount",
      install_route: "pip",
      package: "csvcount",
      version_command: null,
    },
    history: null,
    labelled_conversations: null,
    horizon: {
      horizon: "short",
      rationale:
        "One process over one input file: a run takes milliseconds and a small input exercises everything it does.",
    },
    ...over,
  });
}

/** A long-horizon workload as the designer would plan it for a harness. */
const WHOLE_APP_TDM215 = {
  id: "whole-app",
  title: "Build a multi-tenant issue tracker from a spec",
  feature_areas: ["auth and tenancy", "issues API", "search", "notifications", "web UI"],
  wall_cap_s: 10_800,
  grading: "partial-credit" as const,
  why: "big enough that one session compacts its context; parallel workers can split the areas",
};

const understandingOf = (u: ReturnType<typeof decideUnderstanding>): KitDesignerUnderstanding =>
  u.understanding;

describe("understander: task horizon (TDM-215)", () => {
  it("the prompt asks for a reasoned horizon and the output schema carries it", () => {
    const role = loadRole(UNDERSTANDER_ROLE);
    expect(role.prompt).toContain("**horizon**");
    expect(role.prompt).toMatch(/coordination harness is never `short`/);
    expect(role.prompt).toMatch(/Reason from what the subject is FOR,\s+not from its name/);
    const json = role.outputSchema as {
      properties: { horizon: { properties: { horizon: { enum: string[] } }; required: string[] } };
    };
    expect(json.properties.horizon.properties.horizon.enum).toEqual(["short", "mixed", "long"]);
    expect(json.properties.horizon.required).toEqual(["horizon", "rationale"]);
  });

  it("a Tandem-like summary yields horizon long, with the model's rationale kept", () => {
    const v = decideUnderstanding(tandemOutputTdm215(), TANDEM);
    expect(v.outcome).toBe("ready");
    expect(v.understanding.horizon).toEqual({ horizon: "long", rationale: TANDEM_RATIONALE });
    expect(v.corrections.some((c) => c.startsWith("horizon"))).toBe(false);
  });

  it("a coordination harness judged short is raised to mixed (rationale kept, correction logged)", () => {
    const v = decideUnderstanding(
      tandemOutputTdm215({ horizon: { horizon: "short", rationale: "the tasks are small" } }),
      TANDEM,
    );
    expect(v.understanding.horizon.horizon).toBe("mixed");
    expect(v.understanding.horizon.rationale).toMatch(/^the tasks are small \(Code raised/);
    expect(v.corrections).toContain(
      "horizon short → mixed: a subject that coordinates agents earns its keep on long work",
    );
    // A model that predates TDM-215 (no horizon at all): code fills the floor.
    const old = decideUnderstanding(tandemOutputTdm215({ horizon: null }), TANDEM);
    expect(old.understanding.horizon.horizon).toBe("mixed");
  });

  it("a single-file CLI yields short, with no correction", () => {
    const cli = singleFileCliTdm215();
    const v = decideUnderstanding(cliOutputTdm215(), cli);
    expect(v.understanding.driver_type).toBe("cli");
    expect(v.understanding.horizon.horizon).toBe("short");
    expect(v.corrections).toEqual([]);
    // No answer at all on a CLI means short, silently.
    expect(
      decideUnderstanding(cliOutputTdm215({ horizon: null }), cli).understanding.horizon,
    ).toMatchObject({ horizon: "short" });
  });

  it("coordination is read from what the subject does, never from its name", () => {
    // Named Tandem, but a plain CLI: no floor.
    expect(
      isCoordinationSubject({
        kind: "software",
        driver_type: "cli",
        summary: "tandem prints two files side by side",
      }),
    ).toBe(false);
    // Unnamed, an agent whose summary describes an orchestrator of workers: the floor applies.
    expect(
      isCoordinationSubject({
        kind: "agent",
        driver_type: "coding-agent",
        summary: "An orchestrator that hands each feature to one of 4 coding agents in parallel.",
      }),
    ).toBe(true);
    // Software that mentions parallelism (worker threads) is not coordinating agents.
    expect(
      isCoordinationSubject({
        kind: "software",
        driver_type: "cli",
        summary: "Searches files in parallel using 8 workers.",
      }),
    ).toBe(false);
    expect(describesCoordination(TANDEM.digest.summary)).toBe(true);
    expect(describesCoordination("Count rows in CSV files")).toBe(false);
  });
});

describe("kit designer: horizon plan (TDM-215)", () => {
  it("the prompt has a Task horizon section that argues for long workloads on coordination harnesses", () => {
    const p = loadRole(KIT_DESIGNER_ROLE).prompt;
    expect(p).toContain("## Task horizon");
    expect(p).toMatch(/only earns that back when the task is big\s+enough/);
    expect(p).toContain("`partial-credit`");
    expect(p).toMatch(/Keep the short tasks too/);
  });

  it("a Tandem-like understanding requires a long workload, and the design input says so", () => {
    const u = understandingOf(decideUnderstanding(tandemOutputTdm215(), TANDEM));
    const req = horizonRequirement(u);
    expect(req).toMatchObject({
      coordinates_agents: true,
      long_workload_required: true,
      min_horizon: "long",
      long_workload: { min_feature_areas: 3, min_wall_cap_s: 7_200, grading: "partial-credit" },
    });
    const input = buildKitDesignerInput({
      digest: TANDEM.digest,
      understanding: u,
      research: null,
      intakeContenders: [],
      context: null,
    });
    expect((input.understanding as { horizon: unknown }).horizon).toEqual(u.horizon);
    expect(input.horizon_requirement).toEqual(req);
  });

  it("a Tandem-like draft with a long workload next to the short ones passes; without one it is sent back", () => {
    const u = understandingOf(decideUnderstanding(tandemOutputTdm215(), TANDEM));
    const plan = KitHorizonPlanSchema.parse({
      horizon: "long",
      rationale:
        "Tandem coordinates parallel workers: a whole-app build is where that can pay off.",
      long_workloads: [WHOLE_APP_TDM215],
    });
    expect(plan.long_workloads[0]!.wall_cap_s).toBeGreaterThanOrEqual(LONG_HORIZON_MIN_WALL_S);
    expect(draftHorizonIssues(plan, u)).toEqual([]);
    // The full draft schema carries the plan.
    const draft = KitDesignerOutputSchema.parse({ ...TDM60_RG_DRAFT, horizon: plan });
    expect(draft.horizon.long_workloads.map((w) => w.id)).toEqual(["whole-app"]);

    const short = KitHorizonPlanSchema.parse({ horizon: "short", rationale: "small tasks" });
    const issues = draftHorizonIssues(short, u);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^horizon: the draft says short but the understanding is long/);
    expect(issues[1]).toMatch(/^horizon\.long_workloads: this subject needs at least one/);
  });

  it("the schema refuses a long plan with no long workload, or one under 2 h, 3 areas or partial credit", () => {
    const base = { horizon: "long", rationale: "r" };
    expect(KitHorizonPlanSchema.safeParse(base).success).toBe(false);
    for (const bad of [
      { wall_cap_s: 3_600 },
      { feature_areas: ["api", "ui"] },
      { grading: "all-or-nothing" },
    ]) {
      expect(
        KitHorizonPlanSchema.safeParse({
          ...base,
          long_workloads: [{ ...WHOLE_APP_TDM215, ...bad }],
        }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("a CLI draft is short with no long workloads (and a draft from before TDM-215 defaults to that)", () => {
    const u = understandingOf(decideUnderstanding(cliOutputTdm215(), singleFileCliTdm215()));
    expect(horizonRequirement(u)).toMatchObject({
      coordinates_agents: false,
      long_workload_required: false,
      min_horizon: "short",
    });
    const draft = KitDesignerOutputSchema.parse(TDM60_RG_DRAFT);
    expect(draft.horizon).toMatchObject({ horizon: "short", long_workloads: [] });
    expect(draftHorizonIssues(draft.horizon, u)).toEqual([]);
  });
});
