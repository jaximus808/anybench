// TDM-60 [6.6] end to end, LIVE: a non-Tandem public CLI repo through the REAL pipeline on local
// Postgres + Naïve: POST /runs → intake (GitHub ingest) → understand (Naïve understander) →
// research (pass-through) → kit_draft (Naïve kit designer + materializer) → env_build (Naïve) →
// proof (the six checks on Naïve) → awaiting_go (auto_go off). The run.advance job is the
// production one (defaultAgentStages + defaultPipeline from the real config); only the queue is
// in memory. Spends Naïve credit, so it is opt-in:
//
//   cd apps/server && LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench \
//     NAIVE_LIVE=1 TDM60_E2E=1 TDM60_E2E_REPO=BurntSushi/ripgrep TDM60_E2E_OUT=<file> \
//     node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs run \
//     test/kit-designer-e2e-live-tdm60.test.ts --reporter=verbose
//
// It stops before a second proof (a repair) unless TDM60_E2E_ALLOW_REPAIR=1, to bound spend.
import { writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNaiveClient } from "@anybench/naive";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { agentSessions, events, kits, runs } from "../src/db/schema/index.js";
import { createRunAdvanceJob } from "../src/jobs/run-advance.js";
import type { JobContext, JobDef } from "../src/jobs/types.js";
import { createLogger } from "../src/lib/logger.js";
import { MemQueueTdm54 } from "./helpers/orchestrator-tdm54.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { recordingSentryTdm14 } from "./helpers/server-tdm14.js";
import { runsAppTdm67, seedUserTdm67, type RunsAppTdm67 } from "./helpers/runs-tdm67.js";

const LIVE =
  process.env.NAIVE_LIVE === "1" && process.env.TDM60_E2E === "1" && !!process.env.NAIVE_API_KEY;
const available = LIVE && (await pgAvailableTdm11());
const REPO = process.env.TDM60_E2E_REPO ?? "BurntSushi/ripgrep";
const log = (msg: string, data: unknown = {}) =>
  console.log(
    `TDM60-E2E ${new Date().toISOString()} ${msg} ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
  );

describe.skipIf(!available)(`kit designer end to end on Naïve: ${REPO} (TDM-60)`, () => {
  let h: FreshDbTdm11;
  let api: RunsAppTdm67;

  afterAll(async () => {
    await api?.dbh.close();
    await h?.drop();
  });

  it(
    "intake → understand → research → kit_draft → env_build → proof → awaiting_go",
    async () => {
      h = await freshMigratedDbTdm11({ max: 8 });
      api = runsAppTdm67(h.url);
      const userId = await seedUserTdm67(h.db, "tdm60e2e");
      const generated = mkdtempSync(path.join(tmpdir(), "tdm60-e2e-kits-"));
      const config = loadConfig({
        ...process.env,
        DATABASE_URL: h.url,
        DATABASE_URL_DIRECT: h.url,
        ANYBENCH_GENERATED_KITS_DIR: generated,
        LOG_LEVEL: "info",
      });
      const naive = createNaiveClient({
        apiKey: config.NAIVE_API_KEY!,
        ...(config.NAIVE_BASE_URL ? { baseUrl: config.NAIVE_BASE_URL } : {}),
      });
      const balanceBefore = (await naive.credits.show()).balanceMicroUsd;
      log("balance before", { balanceBefore });

      const ctx: JobContext = {
        config,
        logger: createLogger({
          level: "info",
          destination: { write: (s: string) => process.stdout.write(`TDM60-E2E-LOG ${s}`) },
        }),
        db: h.db,
        sentry: recordingSentryTdm14(),
        workerId: "tdm60-e2e-worker",
        workerStartedAt: new Date(),
      };
      const queue = new MemQueueTdm54();
      const job = createRunAdvanceJob({ jobs: () => queue }) as JobDef;

      const res = await api.app.request("http://api.test/runs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
        body: JSON.stringify({
          question: `Is ${REPO.split("/")[1]} faster than the obvious baseline on the same output?`,
          source: { kind: "github", github: REPO },
          budget_micro_usd: "20000000",
          auto_go: false,
        }),
      });
      expect(res.status).toBe(201);
      const runId = ((await res.json()) as { run: { id: string } }).run.id;
      log("run created", { runId, repo: REPO });
      for (const j of api.jobs.jobs) void queue.add(j.task, j.payload, { jobKey: j.jobKey });

      const helpers = {
        abortSignal: new AbortController().signal,
        job: { attempts: 1, max_attempts: 25 },
        addJob: async (task: string, payload: unknown, spec: { jobKey?: string } = {}) => {
          await queue.add(task, (payload ?? {}) as Record<string, unknown>, spec);
          return {} as never;
        },
      };
      const row = async () => (await h.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
      let seenEvents = 0;
      const printEvents = async () => {
        const evs = await h.db
          .select()
          .from(events)
          .where(eq(events.runId, runId))
          .orderBy(asc(events.seq));
        for (const e of evs.slice(seenEvents)) {
          const p = e.payload as { text?: string; from?: string; to?: string; reason?: string };
          if (e.type === "run.state_changed")
            log("state", { from: p.from, to: p.to, reason: p.reason });
          else if (e.type === "agent.message" && e.sourceId?.startsWith("kit-builder"))
            log("message", { source: e.sourceId, text: p.text?.slice(0, 600) });
          else if (e.type === "agent.message" && e.sourceId === "proof:suite")
            log("proof", { text: p.text?.slice(0, 600) });
        }
        seenEvents = evs.length;
      };

      const terminal = new Set(["awaiting_go", "needs_human", "failed", "cancelled"]);
      let stopped = "";
      for (let n = 0; n < 200; n++) {
        const r = await row();
        await printEvents();
        if (terminal.has(r.state)) break;
        const kitRows = await h.db.select().from(kits).where(eq(kits.runId, runId));
        if (kitRows.length > 1 && process.env.TDM60_E2E_ALLOW_REPAIR !== "1") {
          stopped = "stopped before a second proof (repair) to bound spend";
          break;
        }
        const next = queue.take();
        if (!next) {
          stopped = "queue empty";
          break;
        }
        if (next.task !== "run.advance") continue;
        const parsed = job.payload.safeParse(next.payload);
        if (!parsed.success) continue;
        try {
          await job.run(parsed.data, ctx, helpers as never);
        } catch (err) {
          log("run.advance threw (the job would retry)", { err: String(err).slice(0, 800) });
          await queue.add(next.task, next.payload, { jobKey: `${next.key}:retry${n}` });
        }
      }

      const final = await row();
      const kitRows = await h.db.select().from(kits).where(eq(kits.runId, runId));
      const sessions = await h.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.runId, runId));
      const balanceAfter = (await naive.credits.show()).balanceMicroUsd;
      const computers = await naive.computers.list();
      const summary = {
        run_id: runId,
        repo: REPO,
        state: final.state,
        paused_reason: final.pausedReason,
        stopped,
        estimate_micro_usd: final.estimateMicroUsd,
        kits: kitRows.map((k) => ({
          version: k.version,
          files_url: k.filesUrl,
          hash: k.hash,
          proof: k.proof,
        })),
        sessions: sessions.map((s) => ({
          role: s.role,
          status: s.status,
          cost_micro_usd: s.costMicroUsd,
        })),
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        spent_micro_usd: balanceBefore - balanceAfter,
        computers_left: computers.data.map((c) => ({ id: c.id, name: c.name })),
      };
      log("summary", summary);
      if (process.env.TDM60_E2E_OUT)
        await writeFile(
          process.env.TDM60_E2E_OUT,
          JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
        );
      expect(final.state).toBe("awaiting_go");
    },
    90 * 60_000,
  );
});
