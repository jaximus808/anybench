// TDM-56 [6.2] LIVE: the Naïve understander on the 7-repo fixture and on ripgrep + fd, scored
// against packages/agents/understander/fixtures/expected.json (labels written before any run).
// Runs only with NAIVE_LIVE=1, a key and local Postgres; about $0.05 of Naïve credit:
//   cd apps/server && LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench \
//     NAIVE_LIVE=1 node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs \
//     run test/understander-naive-live-tdm56.test.ts --reporter=verbose
// The fixture repos are read from local checkouts under TDM56_REPOS_ROOT (default
// ~/coding-project): a folder that is not a git repo is snapshotted into a one-commit temp repo.
// ripgrep and fd are fetched from GitHub. TDM56_LIVE_OUT=<file> writes the per-repo results.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestGitHubRepo, ingestLocalRepo, type RepoIngest } from "@anybench/kit";
import { createNaiveClientFromEnv } from "@anybench/naive";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runs, users } from "../src/db/schema/index.js";
import { naiveUnderstand, type NaiveUnderstanding } from "../src/orchestrator/kit-builder.js";
import type { RunIntake, StageContext, StageEventDraft } from "../src/orchestrator/ports.js";
import { writeRepoIngestCache } from "../src/orchestrator/repo-ingest-cache.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const LIVE = process.env.NAIVE_LIVE === "1" && !!process.env.NAIVE_API_KEY;
const available = LIVE && (await pgAvailableTdm11());

const LabelSchema = z.object({
  name: z.string(),
  github: z.url(),
  local: z.string().optional(),
  kind: z.string(),
  benchable: z.string(),
  driver_type: z.string(),
  outcome: z.string(),
  why: z.string(),
});
const ExpectedSchema = z.object({ fixture: z.array(LabelSchema), public: z.array(LabelSchema) });
type Label = z.infer<typeof LabelSchema>;

const EXPECTED = ExpectedSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../packages/agents/understander/fixtures/expected.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
);
const REPOS_ROOT = process.env.TDM56_REPOS_ROOT ?? path.join(homedir(), "coding-project");

function gitTdm56(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=eval@anybench.test", "-c", "user.name=eval", ...args], {
    cwd,
    stdio: "ignore",
  });
}

async function ingestLabel(l: Label): Promise<RepoIngest> {
  if (!l.local) return ingestGitHubRepo(l.github);
  const dir = path.join(REPOS_ROOT, l.local);
  if (existsSync(path.join(dir, ".git"))) return ingestLocalRepo(dir, { githubUrl: l.github });
  // Not a git checkout: snapshot it into a one-commit repo (no history to mine).
  const snap = mkdtempSync(path.join(tmpdir(), `tdm56-snap-${l.name}-`));
  cpSync(dir, snap, {
    recursive: true,
    filter: (src) => !/(^|\/)(node_modules|\.venv|__pycache__)(\/|$)/.test(src),
  });
  gitTdm56(snap, ["init", "-q"]);
  gitTdm56(snap, ["add", "-A"]);
  gitTdm56(snap, ["commit", "-q", "-m", "snapshot"]);
  return ingestLocalRepo(snap, { githubUrl: l.github });
}

interface LiveRowTdm56 {
  name: string;
  expected: { kind: string; benchable: string; driver_type: string; outcome: string };
  got: {
    kind?: string;
    benchable?: string;
    driver_type?: string;
    supported?: boolean;
    outcome: string;
    reason: string;
    corrections: string[];
    claims: number;
  };
  match: boolean;
  costMicroUsd: string;
  attempts: number;
}

describe.skipIf(!available)("understander on live Naïve (TDM-56)", () => {
  let fresh: FreshDbTdm11;
  let ownerId: string;
  const cacheDir = mkdtempSync(path.join(tmpdir(), "tdm56-live-cache-"));
  const client = LIVE ? createNaiveClientFromEnv() : (null as never);
  const rows: LiveRowTdm56[] = [];

  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11({ max: 2 });
    const [u] = await fresh.db
      .insert(users)
      .values({ githubLogin: "tdm56-live", githubId: 5_600_099 })
      .returning();
    ownerId = u!.id;
  }, 60_000);

  afterAll(async () => {
    if (process.env.TDM56_LIVE_OUT) {
      writeFileSync(process.env.TDM56_LIVE_OUT, `${JSON.stringify(rows, null, 2)}\n`);
    }
    await fresh?.drop();
  });

  async function understandLive(l: Label): Promise<LiveRowTdm56> {
    const ingest = await ingestLabel(l);
    await writeRepoIngestCache(ingest, { dir: cacheDir });
    const intake: RunIntake = {
      source: { kind: "github", github: l.github },
      contenders: [],
      auto_go: true,
    };
    const [r] = await fresh.db
      .insert(runs)
      .values({ ownerId, question: `understand ${l.name}`, budgetMicroUsd: 1_000_000n, intake })
      .returning();
    const emitted: StageEventDraft[] = [];
    const ctx: StageContext = {
      run: {
        id: r!.id,
        owner_id: ownerId,
        project_id: null,
        question: `understand ${l.name}`,
        intake,
        budget_micro_usd: 1_000_000n,
        spent_micro_usd: 0n,
      },
      idempotencyKey: `${r!.id}:understand:0`,
      signal: new AbortController().signal,
      emit: async (d) => {
        emitted.push(...d);
      },
    };
    // Naïve capacity 429s throw (transient): retry the stage; the same key replays the session.
    let out: NaiveUnderstanding | undefined;
    let attempts = 0;
    for (; attempts < 8 && !out; attempts++) {
      try {
        out = await naiveUnderstand(
          { db: fresh.db, client, ingestCacheDir: cacheDir },
          ctx,
          ingest.digest,
        );
      } catch (err) {
        console.log(`${l.name}: transient (${String(err).slice(0, 160)}), retrying in 20 s`);
        await new Promise((res) => setTimeout(res, 20_000));
      }
    }
    if (!out) throw new Error(`${l.name}: no answer after ${attempts} attempts`);
    const u = out.verdict?.understanding;
    const outcome = out.verdict?.outcome ?? `stage ${out.result.ok ? "ok" : out.result.outcome}`;
    const row: LiveRowTdm56 = {
      name: l.name,
      expected: {
        kind: l.kind,
        benchable: l.benchable,
        driver_type: l.driver_type,
        outcome: l.outcome,
      },
      got: {
        ...(u
          ? {
              kind: u.kind,
              benchable: u.benchable,
              driver_type: u.driver_type,
              supported: u.supported,
            }
          : {}),
        outcome,
        reason: out.result.ok ? (u?.reason ?? "") : out.result.reason,
        corrections: out.verdict?.corrections ?? [],
        claims: u?.claims.length ?? 0,
      },
      match: u?.kind === l.kind && u?.benchable === l.benchable,
      costMicroUsd: String(out.costMicroUsd ?? 0n),
      attempts,
    };
    console.log(
      `${row.match ? "MATCH" : "MISS "} ${l.name.padEnd(16)} expected ${l.kind}/${l.benchable}/${l.driver_type}/${l.outcome}` +
        ` got ${row.got.kind}/${row.got.benchable}/${row.got.driver_type}/${row.got.outcome}` +
        ` ${row.costMicroUsd} µ$ "${row.got.reason.slice(0, 160)}"` +
        (row.got.corrections.length ? ` corrections: ${row.got.corrections.join("; ")}` : ""),
    );
    rows.push(row);
    return row;
  }

  it("matches kind + benchable on at least 6 of the 7 fixture repos", async () => {
    const results: LiveRowTdm56[] = [];
    for (const l of EXPECTED.fixture) results.push(await understandLive(l));
    const matched = results.filter((r) => r.match).length;
    const cost = results.reduce((s, r) => s + BigInt(r.costMicroUsd), 0n);
    console.log(`fixture: ${matched}/${results.length} match, ${cost} µ$`);
    expect(matched).toBeGreaterThanOrEqual(6);
  }, 1_800_000);

  it("ripgrep and fd are cli / ready / supported", async () => {
    for (const l of EXPECTED.public) {
      const r = await understandLive(l);
      expect(r.got).toMatchObject({
        kind: "software",
        benchable: "ready",
        driver_type: "cli",
        supported: true,
        outcome: "ready",
      });
    }
    const total = rows.reduce((s, r) => s + BigInt(r.costMicroUsd), 0n);
    console.log(`live total: ${total} µ$ over ${rows.length} sessions`);
  }, 900_000);
});
