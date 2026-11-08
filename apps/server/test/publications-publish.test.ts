// Publish worktree: POST /runs/:id/publication freezes a delivered run into a signed, versioned
// snapshot under an unguessable slug; GET /public/r/:slug serves and verifies it with no login;
// unpublish makes it read "withdrawn"; the keyset is public. Against local Postgres (skips without
// it). Throwaway Ed25519 keys generated here; never reads .env.
import { generateKeyPairSync } from "node:crypto";
import {
  ApiClientError,
  apiRoutes,
  createApiClient,
  newId,
  PROOF_CHECKS,
  PublicationSlugSchema,
  ReportSchema,
  TrialIdSchema,
  type ApiClient,
  type Report,
  type RunId,
} from "@anybench/core";
import { verifyDocument } from "@anybench/publish";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPublication,
  badgeOf,
  newPublicationSlug,
  publishable,
} from "../src/lib/publication.js";
import {
  contenders,
  kits,
  publishVersions,
  reports,
  runs,
  trials,
} from "../src/db/schema/index.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const BASE = "http://api.test";

function keyEnvPublish() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    PUBLISH_SIGNING_KEY_ID: "ab-test-pub",
    PUBLISH_SIGNING_PRIVATE_KEY_DER_B64: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    PUBLISH_SIGNING_PUBLIC_KEY_DER_B64: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

const KIT_PUBLISH = {
  schema_version: 2,
  subject: { kind: "harness", name: "tandem", summary: "x", better_means: ["more pass"] },
  contenders: [
    {
      id: "claude-code-solo",
      name: "A · Claude Code solo",
      role: "baseline",
      driver: { type: "coding-agent", model: "anthropic/claude-opus-5.5" },
      versions: { CLAUDE_CODE_VERSION: "2.1.319" },
    },
    {
      id: "tandem",
      name: "Tandem",
      role: "subject",
      driver: { type: "harness", model: "anthropic/claude-opus-5.5" },
      version: "tandem@0.2.0",
      versions: { CLAUDE_CODE_VERSION: "2.1.319", TANDEM_VERSION: "0.2.0" },
    },
  ],
  workloads: [
    { id: "todo-api", title: "Build a REST API", params: { hidden_tests: 16, shape: "splits" } },
    { id: "bug-hunt", title: "Fix a planted bug", params: { hidden_tests: 12 } },
  ],
  gates: [{ id: "hidden-tests", kind: "hidden-tests", description: "Runs the hidden tests." }],
  requirements: [{ id: "tests-pass", type: "measured", title: "Hidden tests pass" }],
};

function reportPublish(runId: string, baseline: string, subject: string, curated = true): Report {
  const req = (cmp: unknown) => ({
    requirement_id: "tests-pass",
    type: "measured",
    title: "Hidden tests pass",
    value: 0.67,
    unit: "ratio",
    ci95: null,
    gate_id: "hidden-tests",
    gate_pass_rate: 0.67,
    score: null,
    n: 3,
    survivorship: false,
    comparison: cmp,
  });
  return ReportSchema.parse({
    run_id: runId,
    kit_id: null,
    answer:
      "Result on tests-pass (the primary requirement): tandem vs claude-code-solo: no detectable difference at n=3 vs 3. proof: curated (verified offline at bebb77e) tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals",
    comped: false,
    contenders: [
      {
        contender_id: baseline,
        name: "A · Claude Code solo",
        role: "baseline",
        score: null,
        ci95: null,
        delta_vs_baseline: null,
        requirements: [req(null)],
        wins: [],
        losses: [],
      },
      {
        contender_id: subject,
        name: "Tandem",
        role: "subject",
        score: null,
        ci95: null,
        delta_vs_baseline: null,
        requirements: [
          req({
            baseline_id: baseline,
            verdict: "indistinguishable",
            test: "fisher_exact",
            p: 1,
            p_adjusted: 1,
            alpha: 0.05,
            family: 1,
            effect: { measure: "rate_diff", value: 0, hodges_lehmann: null },
            diff_ci: {
              lo: -0.6,
              hi: 0.6,
              level: 0.95,
              requested_level: 0.95,
              attained: true,
              unit: "rate",
            },
            n: { candidate: 3, baseline: 3, tasks: 2 },
            mde: { value: null, unit: "rate", metric_shift: null },
            claim: "these_tasks",
            downgraded: null,
            statement: "no detectable difference at n=3 vs 3, smallest detectable difference=none",
          }),
        ],
        wins: [],
        losses: [],
      },
    ],
    where_it_breaks: [],
    bottlenecks: [],
    proof: PROOF_CHECKS.map((check) => ({
      check,
      pass: curated ? check === "oracle_passes" || check === "do_less_fails" : false,
      reason: "proof: curated (verified offline at bebb77e): oracle 28/28",
      evidence: [],
    })),
    failures: { infra: 1, subject: 0, gate: 2, kit: 0, budget: 0, timeout: 0 },
    postmortem: null,
    generated_at: "2026-11-07T23:00:00.000Z",
  });
}

describe("publication helpers", () => {
  it("slugs are 20 of [a-z0-9] and do not repeat", () => {
    const s = new Set(Array.from({ length: 200 }, () => newPublicationSlug()));
    expect(s.size).toBe(200);
    for (const x of s) expect(PublicationSlugSchema.safeParse(x).success).toBe(true);
  });

  it("only a delivered run with a proven or curated gate is publishable", () => {
    const r = reportPublish(newId(TrialIdSchema), newId(TrialIdSchema), newId(TrialIdSchema));
    expect(publishable({ state: "running" }, r)).toMatchObject({ ok: false });
    expect(publishable({ state: "delivered" }, r)).toMatchObject({ ok: true, basis: "curated" });
    const unproven = reportPublish(
      newId(TrialIdSchema),
      newId(TrialIdSchema),
      newId(TrialIdSchema),
      false,
    );
    expect(publishable({ state: "delivered" }, unproven).ok).toBe(false);
  });

  it("the badge never claims a winner the verdict didn't call, and keeps the scope", () => {
    const r = reportPublish(newId(TrialIdSchema), newId(TrialIdSchema), newId(TrialIdSchema));
    expect(badgeOf(r, "tandem")).toMatchObject({
      verdict: "indistinguishable",
      message: "Tandem vs Claude Code solo: no detectable difference",
      scope: "on these 2 tasks",
    });
  });

  it("groups vary setups under one name and words a called verdict with its requirement", () => {
    const base = reportPublish(newId(TrialIdSchema), newId(TrialIdSchema), newId(TrialIdSchema));
    const subj = base.contenders[1]!;
    const many = {
      ...base,
      contenders: [
        base.contenders[0]!,
        ...["C · Tandem ×1", "D · Tandem ×3"].map((name) => ({
          ...subj,
          requirements: structuredClone(subj.requirements),
          contender_id: newId(TrialIdSchema) as unknown as typeof subj.contender_id,
          name,
        })),
      ],
    };
    expect(badgeOf(many, "tandem").message).toBe(
      "Tandem vs Claude Code solo: no detectable difference",
    );
    const better = structuredClone(many);
    const cmp = better.contenders[2]!.requirements[0]!.comparison!;
    Object.assign(cmp, {
      verdict: "better",
      p_adjusted: 0.01,
      effect: { ...cmp.effect, value: 0.5 },
      statement: "better on these 2 tasks",
    });
    expect(badgeOf(better, "tandem")).toMatchObject({
      verdict: "better",
      message: "Tandem ×3 vs Claude Code solo: better on tests-pass",
      scope: "on these 2 tasks",
    });
  });

  it("buildPublication carries setups, tasks, gates, trial counts and the disclosure", () => {
    const [runId, a, b] = [newId(TrialIdSchema), newId(TrialIdSchema), newId(TrialIdSchema)];
    const pub = buildPublication({
      slug: "abcdefghij0123456789",
      version: 1,
      now: new Date("2026-11-08T00:00:00Z"),
      run: {
        id: runId,
        question: "Does Tandem beat Claude Code?",
        state: "delivered",
        createdAt: new Date("2026-11-07T20:00:00Z"),
        stageOutputs: { finalized_at: "2026-11-07T23:01:00.000Z" },
      },
      kit: { spec: KIT_PUBLISH, hash: "f".repeat(64), version: 1 },
      report: reportPublish(runId, a, b),
      contenders: [
        { id: a, source: "claude-code-solo", role: "baseline" },
        { id: b, source: "tandem", role: "subject" },
      ],
      trials: [
        {
          contenderId: a,
          repeat: 0,
          state: "done",
          gate: { "hidden-tests": { pass: true, reason: "ok", evidence: [] } },
          metrics: null,
          costMicroUsd: 0n,
        },
        {
          contenderId: b,
          repeat: 0,
          state: "failed_subject",
          gate: null,
          metrics: null,
          costMicroUsd: 0n,
        },
        {
          contenderId: b,
          repeat: 1,
          state: "failed_infra",
          gate: null,
          metrics: null,
          costMicroUsd: 0n,
        },
        { contenderId: b, repeat: -1, state: "done", gate: null, metrics: null, costMicroUsd: 0n },
      ],
    });
    expect(pub.evaluation.disclosure).toBe(
      "tokens: naive-proxy, effort: naive-min, thinking: off; simulated approvals",
    );
    expect(pub.verdict).not.toContain("proof:");
    expect(pub.evaluation.trials).toEqual({
      graded: 2,
      gate_passed: 1,
      infra_excluded: 1,
      cancelled: 0,
      warmups: 1,
    });
    expect(pub.evaluation.setups[1]).toMatchObject({
      model: "anthropic/claude-opus-5.5",
      version: "tandem@0.2.0",
      versions: { TANDEM_VERSION: "0.2.0" },
      graded_trials: 1,
    });
    expect(pub.evaluation.tasks[0]).toMatchObject({ id: "todo-api", hidden_tests: 16 });
    expect(pub.evaluation.proof.basis).toBe("curated");
    expect(pub.evaluation.metrics).toEqual({ wall_clock: false, cost: false });
    expect(pub.evaluation.run_delivered_at).toBe("2026-11-07T23:01:00.000Z");
  });
});

async function expectStatus(p: Promise<unknown>, status: number) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).status).toBe(status);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe.skipIf(!available)("publication routes", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;
  let a: ApiClient;
  let b: ApiClient;
  let anon: ApiClient;
  let runId: RunId;
  const env = keyEnvPublish();

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url, { env });
    const alice = await seedUserTdm67(db.db, "alice-pub");
    const bob = await seedUserTdm67(db.db, "bob-pub");
    const fetcher = {
      fetch: (url: string, init?: RequestInit) => Promise.resolve(h.app.request(url, init)),
    };
    a = createApiClient(BASE, { kind: "apiKey", key: alice }, fetcher);
    b = createApiClient(BASE, { kind: "apiKey", key: bob }, fetcher);
    anon = createApiClient(BASE, { kind: "none" }, fetcher);
    const [run] = await db.db
      .insert(runs)
      .values({
        ownerId: alice,
        question: "Does Tandem beat Claude Code?",
        state: "running",
        budgetMicroUsd: 5_000_000n,
      })
      .returning();
    runId = run!.id as RunId;
    const [kit] = await db.db
      .insert(kits)
      .values({ ownerId: alice, runId, version: 1, spec: KIT_PUBLISH, hash: "f".repeat(64) })
      .returning();
    await db.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, runId));
    const [ca, cb] = await db.db
      .insert(contenders)
      .values([
        { runId, kitId: kit!.id, source: "claude-code-solo", role: "baseline", status: "kept" },
        { runId, kitId: kit!.id, source: "tandem", role: "subject", status: "kept" },
      ])
      .returning();
    await db.db.insert(trials).values([
      {
        id: newId(TrialIdSchema),
        ownerId: alice,
        runId,
        contenderId: ca!.id,
        workloadId: "todo-api",
        repeat: 0,
        state: "done",
        gate: { "hidden-tests": { pass: true, reason: "ok", evidence: [] } },
      },
      {
        id: newId(TrialIdSchema),
        ownerId: alice,
        runId,
        contenderId: cb!.id,
        workloadId: "todo-api",
        repeat: 0,
        state: "failed_infra",
      },
    ]);
    await db.db.insert(reports).values({
      ownerId: alice,
      runId,
      json: reportPublish(runId, ca!.id, cb!.id),
      md: "# report",
    });
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  it("refuses to publish a run that isn't delivered", async () => {
    await expectStatus(a.call(apiRoutes.publications.publish, { params: { id: runId } }), 409);
  });

  it("publishes, verifies publicly, is idempotent, withdraws and restores", async () => {
    await db.db.update(runs).set({ state: "delivered" }).where(eq(runs.id, runId));
    expect(await a.call(apiRoutes.publications.get, { params: { id: runId } })).toEqual({
      publication: null,
    });
    await expectStatus(b.call(apiRoutes.publications.publish, { params: { id: runId } }), 404);

    const { publication } = await a.call(apiRoutes.publications.publish, {
      params: { id: runId },
    });
    expect(publication).toMatchObject({
      status: "live",
      latest_version: 1,
      page_url: `https://anybench.jaxonp.com/r/${publication.slug}`,
      badge: { message: "Tandem vs Claude Code solo: no detectable difference" },
    });

    const pub = await anon.call(apiRoutes.publications.public, {
      params: { slug: publication.slug },
    });
    if (pub.status !== "live") throw new Error("expected live");
    expect(pub.verification).toMatchObject({ valid: true, key_id: "ab-test-pub" });
    expect(pub.signed.payload.evaluation.trials.infra_excluded).toBe(1);
    expect(pub.versions.map((v) => v.version)).toEqual([1]);

    // The exact signed text verifies against the public keyset, and a changed byte doesn't.
    const att = await h.app.request(`${BASE}/public/r/${publication.slug}/attestation.json`);
    const text = await att.text();
    const keys = await (await h.app.request(`${BASE}/.well-known/anybench-keys.json`)).json();
    expect(verifyDocument(text, keys).valid).toBe(true);
    expect(verifyDocument(text.replace("no detectable", "a detectable"), keys).valid).toBe(false);

    // TDM-206's older route is an alias: same publication, same slug (its chosen slug is ignored).
    const legacy = await a.call(apiRoutes.publish.publish, {
      params: { id: runId },
      body: { slug: "my-chosen-slug" },
    });
    expect(legacy.benchmark).toMatchObject({
      slug: publication.slug,
      page_url: publication.page_url,
      latest_version: 1,
    });
    expect(legacy.version.attestation.trial_count).toBe(1);

    // Same report → same version.
    const again = await a.call(apiRoutes.publications.publish, { params: { id: runId } });
    expect(again.publication.latest_version).toBe(1);
    expect(again.publication.slug).toBe(publication.slug);

    // Versions are immutable in the database.
    await expect(
      db.db.update(publishVersions).set({ signature: "x" }).where(eq(publishVersions.version, 1)),
    ).rejects.toThrow();

    const w = await a.call(apiRoutes.publications.unpublish, { params: { id: runId } });
    expect(w.publication.status).toBe("withdrawn");
    const gone = await anon.call(apiRoutes.publications.public, {
      params: { slug: publication.slug },
    });
    expect(gone.status).toBe("withdrawn");
    expect(
      (await h.app.request(`${BASE}/public/r/${publication.slug}/attestation.json`)).status,
    ).toBe(404);

    const back = await a.call(apiRoutes.publications.publish, { params: { id: runId } });
    expect(back.publication).toMatchObject({ status: "live", slug: publication.slug });
    await expectStatus(
      anon.call(apiRoutes.publications.public, { params: { slug: "zzzzzzzzzzzzzzzzzzzz" } }),
      404,
    );
  });
});

describe("scoreCells (scoreboard counts in the snapshot)", () => {
  it("counts per setup, overall and per task; time only from gate-passing trials", async () => {
    const { scoreCells } = await import("../src/lib/publication.js");
    const tr = (c: string, w: string, ok: boolean, wall: number, cost: bigint) => ({
      contenderId: c,
      workloadId: w,
      repeat: 0,
      state: "done",
      gate: null,
      metrics: { wall_s: wall },
      costMicroUsd: cost,
    });
    const graded = [
      tr("a", "x", true, 10, 100n),
      tr("a", "y", false, 99, 300n),
      tr("b", "x", true, 30, 1000n),
    ];
    const cells = scoreCells(["a", "b"], graded, [graded[0]!, graded[2]!]);
    expect(cells.find((c) => c.contender_id === "a" && c.workload_id === null)).toMatchObject({
      graded: 2,
      passed: 1,
      cost_micro_usd: 400,
      wall_s_mean: 10,
      wall_n: 1,
    });
    expect(cells.filter((c) => c.contender_id === "b").map((c) => c.workload_id)).toEqual([
      null,
      "x",
      "y",
    ]);
    expect(cells.find((c) => c.contender_id === "b" && c.workload_id === "y")).toMatchObject({
      graded: 0,
      wall_s_mean: null,
    });
  });
});
