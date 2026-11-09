// TDM-245 [21.5]: the harness league as a curated kit. The question picks it ("harness league",
// "skills league"), the workload (project-tracker unless the xl rung is named) and the repeats
// ("n=5"); its proof is E18's offline sign-off, accepted only while the league's arena is still a
// byte-identical copy; its report carries HARNESS_LEAGUE_DISCLOSURE. The run the founder creates
// stops at awaiting_go: nothing here starts a trial.
import { appendFileSync, cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { byokTokenCeilingMicroUsd } from "@anybench/billing";
import { isAgentDriver, safeParseKitSpec, type KitSpec } from "@anybench/core";
import { loadKit } from "@anybench/kit";
import { FakeProvider } from "@anybench/providers";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, kits, runs, trials } from "../src/db/schema/index.js";
import {
  CURATED_HARNESS_LEAGUE_KIT,
  CURATED_LONG_HORIZON_KIT,
  CURATED_TANDEM_KIT,
  curatedDisclosure,
  curatedKitFor,
  curatedKitOfSpec,
  curatedKitStages,
  defaultKitsDir,
  LEAGUE_V1_WORKLOAD,
  LEAGUE_XL_WORKLOAD,
  leagueChoiceFor,
  leagueProfile,
  trialCount,
} from "../src/orchestrator/curated.js";
import { FakePipeline } from "../src/orchestrator/fake.js";
import type { PipelinePort, StageContext } from "../src/orchestrator/ports.js";
import {
  curatedProof,
  HARNESS_LEAGUE_DISCLOSURE,
  HARNESS_LEAGUE_PROOF_SIGNOFF,
  kitScore,
  LONG_HORIZON_DISCLOSURE,
  LONG_HORIZON_PROOF_SIGNOFF,
  PROOF_SUITE_UNAVAILABLE,
  sharedArenaProblems,
} from "../src/orchestrator/proof-score.js";
import { fakeRunnerTdm49 } from "./helpers/fake-runner-tdm49.js";
import {
  digestTdm54,
  drainTdm54,
  MemQueueTdm54,
  workerTdm54,
} from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";

/** The question docs/findings/harness-league-run-plan.md gives the founder, word for word. */
const LEAGUE_QUESTION_TDM245 =
  "Harness league on project-tracker (v1), n=5: do Claude Code skill packs and harnesses (subagents, gstack, Superpowers, Tandem x3) beat plain Claude Code on a whole-app build?";

const LEAGUE_SETUPS = [
  "claude-code-solo",
  "claude-code-subagents",
  "gstack",
  "superpowers",
  "tandem",
];
const quietCtx = { emit: async () => {} } as unknown as StageContext;

async function leagueKit(): Promise<KitSpec> {
  return (await loadKit(path.join(defaultKitsDir(), CURATED_HARNESS_LEAGUE_KIT))).spec;
}

/** The kit the designer stores for `question` (curatedKitStages on the repo's real kits). */
async function designedTdm245(question: string) {
  const said: string[] = [];
  const ctx = {
    run: {
      id: "run-tdm245",
      owner_id: "u",
      project_id: null,
      question,
      intake: { source: { kind: "github", github: "jaximus808/tandem", ref: "main" } },
      budget_micro_usd: 150_000_000n,
      spent_micro_usd: 0n,
    },
    idempotencyKey: "run-tdm245:kit_draft:0",
    signal: new AbortController().signal,
    emit: async (es: { payload: { text?: string } }[]) => {
      for (const e of es) if (e.payload.text) said.push(e.payload.text);
    },
  } as unknown as StageContext;
  const r = await curatedKitStages().designKit(ctx, {
    digest: null,
    understanding: null,
    research: null,
    previous: null,
  });
  return { r, said };
}

/** The founder's `anybench run` command in docs/findings/harness-league-run-plan.md. */
function planCommandTdm245(): string {
  const doc = readFileSync(
    fileURLToPath(new URL("../../../docs/findings/harness-league-run-plan.md", import.meta.url)),
    "utf8",
  );
  const lines = doc.split("\n").filter((l) => /^\s*node apps\/cli\/dist\/index\.js run /.test(l));
  expect(lines, "exactly one anybench run command in the run plan").toHaveLength(1);
  return lines[0]!;
}

describe("harness league selection (TDM-245, no DB)", () => {
  it("the run plan's command picks the league on v1 at n=5, with the $150 BYOK limit and no auto-go", async () => {
    const cmd = planCommandTdm245();
    const question = /--question "([^"]+)"/.exec(cmd)?.[1];
    expect(question).toBe(LEAGUE_QUESTION_TDM245);
    expect(cmd).toMatch(/ --repo github\.com\/jaximus808\/tandem /);
    expect(cmd).toMatch(/ --budget 60 /);
    expect(cmd).toMatch(/ --byok-limit 150 /);
    expect(cmd).toMatch(/ --no-auto-go( |$)/);
    expect(cmd).not.toMatch(/--auto-go/);
    // Neither the long-horizon kit nor the xl rung: the league, v1 only, 5 each.
    expect(curatedKitFor(question!)).toBe(CURATED_HARNESS_LEAGUE_KIT);
    const choice = leagueChoiceFor(question!, 5);
    expect(choice).toEqual({
      ok: true,
      choice: {
        workloads: [LEAGUE_V1_WORKLOAD],
        repeats: 5,
        workloadsFrom: "question",
        repeatsFrom: "question",
      },
    });
    const spec = leagueProfile(await leagueKit(), { workloads: [LEAGUE_V1_WORKLOAD], repeats: 5 });
    expect(spec.ok && trialCount(spec.spec)).toBe(25);
  });

  it("the question picks the league; every other question keeps its kit", () => {
    expect(curatedKitFor(LEAGUE_QUESTION_TDM245)).toBe(CURATED_HARNESS_LEAGUE_KIT);
    expect(curatedKitFor("Skills League: do skill packs help?")).toBe(CURATED_HARNESS_LEAGUE_KIT);
    expect(curatedKitFor("run the skill-league")).toBe(CURATED_HARNESS_LEAGUE_KIT);
    expect(curatedKitFor("harness-league smoke")).toBe(CURATED_HARNESS_LEAGUE_KIT);
    expect(curatedKitFor("Does Tandem beat Claude Code on a whole app?")).toBe(
      CURATED_LONG_HORIZON_KIT,
    );
    expect(curatedKitFor("a harness for the league table")).toBe(CURATED_LONG_HORIZON_KIT);
    expect(curatedKitFor("null pilot")).toBe(CURATED_TANDEM_KIT);
  });

  it("workload and repeats come from the question: v1 and the kit's 5 by default", () => {
    const pick = (q: string) => {
      const r = leagueChoiceFor(q, 5);
      if (!r.ok) throw new Error(r.reason);
      return [r.choice.workloads, r.choice.repeats, r.choice.workloadsFrom, r.choice.repeatsFrom];
    };
    expect(pick(LEAGUE_QUESTION_TDM245)).toEqual([[LEAGUE_V1_WORKLOAD], 5, "question", "question"]);
    expect(pick("harness league")).toEqual([[LEAGUE_V1_WORKLOAD], 5, "default", "kit"]);
    expect(pick("harness league on project-tracker-xl, 6 repeats")).toEqual([
      [LEAGUE_XL_WORKLOAD],
      6,
      "question",
      "question",
    ]);
    expect(pick("skills league, the XL rung, n = 3")[0]).toEqual([LEAGUE_XL_WORKLOAD]);
    expect(pick("harness league on both workloads")[0]).toEqual([
      LEAGUE_V1_WORKLOAD,
      LEAGUE_XL_WORKLOAD,
    ]);
    expect(pick("harness league, v1 and v2")[0]).toEqual([LEAGUE_V1_WORKLOAD, LEAGUE_XL_WORKLOAD]);
    expect(pick("harness league smoke")).toEqual([[LEAGUE_V1_WORKLOAD], 1, "default", "smoke"]);
    expect(pick("harness league, 7 trials per setup")[1]).toBe(7);
    expect(pick("harness league, repeats: 8")[1]).toBe(8);
    for (const q of ["harness league n=0", "harness league n=11", "harness league, 50 repeats"]) {
      const r = leagueChoiceFor(q, 5);
      expect(r.ok, q).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/runs 1 to 10 trials per setup/);
    }
  });

  it("the founder's run: 5 setups × project-tracker × 5 = 25 trials, $25 and 3 h per trial on the owner's key", async () => {
    const { r, said } = await designedTdm245(LEAGUE_QUESTION_TDM245);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const spec = r.value.spec as KitSpec;
    expect(r.value.files_dir).toBe(path.join(defaultKitsDir(), CURATED_HARNESS_LEAGUE_KIT));
    expect(spec.contenders.map((c) => c.id)).toEqual(LEAGUE_SETUPS);
    expect(spec.workloads.map((w) => w.id)).toEqual([LEAGUE_V1_WORKLOAD]);
    expect(spec.repeats).toBe(5);
    expect(spec.schedule.warmups).toBe(0);
    expect(trialCount(spec)).toBe(25);
    for (const c of spec.contenders) {
      expect(isAgentDriver(c.driver), c.id).toBe(true);
      if (!isAgentDriver(c.driver)) continue;
      expect(c.driver.token_cap_micro_usd, c.id).toBe(25_000_000n);
      expect(c.driver.wall_clock_cap_s, c.id).toBe(10_800);
      expect(c.driver.model, c.id).toBe("claude-opus-5-5");
      expect(c.driver.env?.AB_TOKEN_SOURCE, c.id).toBe("anthropic_key");
    }
    // The ceiling on the owner's Anthropic key if every trial hit its cap.
    expect(byokTokenCeilingMicroUsd(spec)).toBe(625_000_000n);
    expect(said[0]).toBe(
      `using the curated harness league (${CURATED_HARNESS_LEAGUE_KIT}): A · Claude Code solo, B · Claude Code + subagents, G · Claude Code + gstack, S · Claude Code + Superpowers, D · Tandem ×3 on E18's whole-app arena (${HARNESS_LEAGUE_DISCLOSURE})`,
    );
    expect(said[1]).toBe(
      "league profile: 25 trials (5 setups × project-tracker × 5 repeats, no warm-up; each up to 3 h and $25 of tokens); workload from the question, repeats from the question",
    );
  });

  it("a question the league can't run holds at kit design with the reason", async () => {
    const { r, said } = await designedTdm245("harness league, n=40");
    expect(r).toEqual({
      ok: false,
      outcome: "needs_human",
      reason: "the harness league runs 1 to 10 trials per setup; the question asks for 40",
    });
    expect(said).toEqual([
      "the harness league runs 1 to 10 trials per setup; the question asks for 40",
    ]);
  });

  it("its proof is E18's sign-off, for the league's own record and every cut the designer makes", async () => {
    const spec = await leagueKit();
    expect(HARNESS_LEAGUE_PROOF_SIGNOFF).toMatchObject({
      source: "kits/harness-league/PROOF.md",
      commit: LONG_HORIZON_PROOF_SIGNOFF.commit,
      sha256: LONG_HORIZON_PROOF_SIGNOFF.sha256,
      shared_with: "kits/tandem-long-horizon",
    });
    expect(await sharedArenaProblems(path.join(defaultKitsDir(), CURATED_HARNESS_LEAGUE_KIT))).toBe(
      null,
    );
    const founders = leagueProfile(spec, { workloads: [LEAGUE_V1_WORKLOAD], repeats: 5 });
    const xl = leagueProfile(spec, { workloads: [LEAGUE_XL_WORKLOAD], repeats: 10 });
    expect(founders.ok && xl.ok).toBe(true);
    for (const kit of [spec, founders.ok ? founders.spec : spec, xl.ok ? xl.spec : spec]) {
      const r = await curatedProof()(quietCtx, { kit_id: "k", kit, env: null });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value).toMatchObject({
        basis: "curated",
        source: HARNESS_LEAGUE_PROOF_SIGNOFF.source,
        commit: LONG_HORIZON_PROOF_SIGNOFF.commit,
        sha256: LONG_HORIZON_PROOF_SIGNOFF.sha256,
        verified: ["oracle_passes", "do_less_fails"],
      });
    }
    // A league the designer would never make (another cap, a dropped setup) is a different kit.
    const edits: KitSpec[] = [
      { ...spec, repeats: 11 },
      { ...spec, contenders: spec.contenders.filter((c) => c.id !== "gstack") },
      {
        ...spec,
        contenders: spec.contenders.map((c) =>
          isAgentDriver(c.driver)
            ? { ...c, driver: { ...c.driver, token_cap_micro_usd: 40_000_000n } }
            : c,
        ),
      },
    ];
    for (const kit of edits) {
      expect(safeParseKitSpec(kit).success).toBe(true);
      const r = await curatedProof()(quietCtx, { kit_id: "k", kit, env: null });
      expect(r).toEqual({ ok: false, outcome: "needs_human", reason: PROOF_SUITE_UNAVAILABLE });
    }
  });

  it("one byte of difference between the league's arena and E18's holds the run at proof", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "league-tdm245-"));
    for (const k of [CURATED_LONG_HORIZON_KIT, CURATED_TANDEM_KIT, CURATED_HARNESS_LEAGUE_KIT]) {
      cpSync(path.join(defaultKitsDir(), k), path.join(dir, k), { recursive: true });
    }
    const spec = (await loadKit(path.join(dir, CURATED_HARNESS_LEAGUE_KIT))).spec;
    const ok = await curatedProof({ kitsDir: dir })(quietCtx, {
      kit_id: "k",
      kit: spec,
      env: null,
    });
    expect(ok.ok).toBe(true);
    // E18's gate changes and the league was not re-synced: E18's proof no longer speaks for it.
    appendFileSync(path.join(dir, CURATED_LONG_HORIZON_KIT, "gates/hidden-tests/check.sh"), "\n");
    const r = await curatedProof({ kitsDir: dir })(quietCtx, { kit_id: "k", kit: spec, env: null });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(
        `the harness-league kit's arena is no longer a byte-identical copy of kits/tandem-long-horizon (1 difference(s): differs: gates/hidden-tests/check.sh); run node kits/harness-league/scripts/sync-shared.mjs; ${PROOF_SUITE_UNAVAILABLE}`,
      );
    }
  });

  it("the report's disclosure follows the league's spec; E18's own spec keeps E18's", async () => {
    const spec = await leagueKit();
    const founders = leagueProfile(spec, { workloads: [LEAGUE_V1_WORKLOAD], repeats: 5 });
    expect(founders.ok).toBe(true);
    if (!founders.ok) return;
    expect(await curatedKitOfSpec(founders.spec)).toBe(CURATED_HARNESS_LEAGUE_KIT);
    expect(curatedDisclosure(CURATED_HARNESS_LEAGUE_KIT)).toBe(HARNESS_LEAGUE_DISCLOSURE);
    const e18 = (await loadKit(path.join(defaultKitsDir(), CURATED_LONG_HORIZON_KIT))).spec;
    expect(await curatedKitOfSpec(e18)).toBe(CURATED_LONG_HORIZON_KIT);
    expect(curatedDisclosure(CURATED_LONG_HORIZON_KIT)).toBe(LONG_HORIZON_DISCLOSURE);
  });
});

const available = await pgAvailableTdm11();
const BASE = "http://api.test";

describe.skipIf(!available)(
  "harness league run up to awaiting_go (TDM-245, local Postgres)",
  () => {
    let h: FreshDbTdm11;
    let api: RunsAppTdm67;
    let userId: string;

    beforeAll(async () => {
      h = await freshMigratedDbTdm11({ max: 8 });
      api = runsAppTdm67(h.url);
      userId = await seedUserTdm67(h.db, "league-tdm245");
    }, 60_000);

    afterAll(async () => {
      await api?.dbh.close();
      await h?.drop();
    });

    it("the founder's command (auto_go false): curated league kit, E18's sign-off, then waits for Go with no trial started", async () => {
      const queue = new MemQueueTdm54();
      const fake = new FakeProvider({ name: "fake-league-tdm245" });
      fakeRunnerTdm49(fake, { stepMs: 5 });
      const p = new FakePipeline({ digest: digestTdm54() });
      const pipeline: PipelinePort = {
        ingest: (ctx) => p.ingest(ctx),
        buildEnv: (ctx) => p.buildEnv(ctx),
        estimate: (ctx) => p.estimate(ctx),
        prove: curatedProof(),
        score: kitScore(),
      };
      const w = workerTdm54(h.db, h.url, "league-worker-tdm245", queue, fake, {
        agents: () => curatedKitStages(),
        pipeline: () => pipeline,
        billingGate: () => async () => ({ allowed: true }),
        charges: () => ({ recordRunCharges: async () => {} }),
      });
      const before = api.jobs.jobs.length;
      const res = await api.app.request(`${BASE}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
        body: JSON.stringify({
          question: LEAGUE_QUESTION_TDM245,
          source: { kind: "github", github: "github.com/jaximus808/tandem" },
          budget_micro_usd: "60000000",
          auto_go: false,
        }),
      });
      const json = (await res.json()) as { run?: { id: string } };
      expect(res.status, JSON.stringify(json)).toBe(201);
      for (const j of api.jobs.jobs.slice(before)) {
        void queue.add(j.task, j.payload, { jobKey: j.jobKey });
      }
      const id = json.run!.id;
      await drainTdm54(w, queue);

      const [run] = await h.db.select().from(runs).where(eq(runs.id, id));
      expect(run!.state, run!.pausedReason ?? "").toBe("awaiting_go");
      const [kit] = await h.db.select().from(kits).where(eq(kits.id, run!.kitId!));
      expect(kit!.filesUrl).toContain(`kits/${CURATED_HARNESS_LEAGUE_KIT}`);
      const stored = safeParseKitSpec(kit!.spec);
      expect(stored.success).toBe(true);
      if (stored.success) {
        expect(trialCount(stored.data)).toBe(25);
        expect(stored.data.workloads.map((x) => x.id)).toEqual([LEAGUE_V1_WORKLOAD]);
      }
      const outputs = run!.stageOutputs as { proof_basis?: { source: string; commit: string } };
      expect(outputs.proof_basis).toMatchObject({
        source: HARNESS_LEAGUE_PROOF_SIGNOFF.source,
        commit: LONG_HORIZON_PROOF_SIGNOFF.commit,
      });
      // Nothing ran: no trial rows until Go.
      expect(await h.db.select().from(trials).where(eq(trials.runId, id))).toEqual([]);
      const said = (
        await h.db
          .select({ payload: events.payload })
          .from(events)
          .where(and(eq(events.runId, id), eq(events.type, "agent.message")))
          .orderBy(asc(events.seq))
      ).map((e) => (e.payload as { text: string }).text);
      expect(said.some((t) => t.startsWith("league profile: 25 trials"))).toBe(true);
    }, 120_000);
  },
);
