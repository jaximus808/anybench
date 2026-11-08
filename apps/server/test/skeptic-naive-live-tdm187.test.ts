// TDM-187 [16.16] LIVE: the skeptic on live Naïve, on the reference Tandem kit and the cli example.
// Runs only with NAIVE_LIVE=1, a key and local Postgres; a few cents of Naïve credit:
//   cd apps/server && LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench \
//     NAIVE_LIVE=1 node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs \
//     run test/skeptic-naive-live-tdm187.test.ts --reporter=verbose
// TDM187_LIVE_OUT=<file> writes every finding and the cost per kit. TDM187_MODEL overrides the model.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSkepticFinding, loadKit } from "@anybench/kit";
import { createNaiveClientFromEnv } from "@anybench/naive";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runs, users } from "../src/db/schema/index.js";
import type { RunIntake, StageContext } from "../src/orchestrator/ports.js";
import { skepticReview, type SkepticReview } from "../src/orchestrator/skeptic.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const LIVE = process.env.NAIVE_LIVE === "1" && !!process.env.NAIVE_API_KEY;
const available = LIVE && (await pgAvailableTdm11());
const here = path.dirname(fileURLToPath(import.meta.url));
const KITS: [string, string][] = [
  ["tandem-vs-claude-code", path.join(here, "../../../kits/tandem-vs-claude-code")],
  ["cli-example", path.join(here, "../../../packages/kit/examples/cli")],
];

describe.skipIf(!available)("skeptic on live Naïve (TDM-187)", () => {
  let fresh: FreshDbTdm11;
  let ownerId: string;
  const client = LIVE ? createNaiveClientFromEnv() : (null as never);
  const rows: { kit: string; review: SkepticReview | null; reason?: string }[] = [];

  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11({ max: 2 });
    const [u] = await fresh.db
      .insert(users)
      .values({ githubLogin: "tdm187-live", githubId: 18_700_001 })
      .returning();
    ownerId = u!.id;
  }, 60_000);

  afterAll(async () => {
    if (process.env.TDM187_LIVE_OUT) {
      writeFileSync(
        process.env.TDM187_LIVE_OUT,
        `${JSON.stringify(rows, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
      );
    }
    await fresh?.drop();
  });

  it("reviews both kits: the Tandem kit needs repair, the cli example has no block", async () => {
    let total = 0n;
    for (const [name, dir] of KITS) {
      const intake: RunIntake = {
        source: { kind: "github", github: "example/x" },
        contenders: [],
        auto_go: true,
      };
      const [r] = await fresh.db
        .insert(runs)
        .values({ ownerId, question: "is it fair?", budgetMicroUsd: 1_000_000n, intake })
        .returning();
      const ctx: StageContext = {
        run: {
          id: r!.id,
          owner_id: ownerId,
          project_id: null,
          question: "is it fair?",
          intake,
          budget_micro_usd: 1_000_000n,
          spent_micro_usd: 0n,
        },
        idempotencyKey: `${r!.id}:kit_draft:0`,
        signal: new AbortController().signal,
        emit: async () => {},
      };
      const kit = await loadKit(dir);
      const res = await skepticReview(
        { db: fresh.db, client },
        {
          ctx,
          kitDir: dir,
          spec: kit.spec,
          ...(process.env.TDM187_MODEL ? { models: [process.env.TDM187_MODEL] } : {}),
        },
      );
      if (!res.ok) {
        rows.push({ kit: name, review: null, reason: res.reason });
        console.log(`${name}: HOLD ${res.reason}`);
        continue;
      }
      rows.push({ kit: name, review: res.value });
      total += res.value.costMicroUsd;
      console.log(
        `${name}: ${res.value.verdict} (model ${res.value.model} advised ${res.value.advisoryVerdict}) ${res.value.costMicroUsd} µ$\n  summary: ${res.value.summary}\n${res.value.findings.map((f) => `  [${f.source}] ${formatSkepticFinding(f)}`).join("\n")}`,
      );
    }
    console.log(`live total: ${total} µ$`);
    const tandem = rows.find((x) => x.kit === "tandem-vs-claude-code")!;
    const cli = rows.find((x) => x.kit === "cli-example")!;
    expect(tandem.review?.verdict).toBe("repair");
    expect(
      cli.review?.findings.filter((f) => f.source === "code" && f.severity === "block"),
    ).toEqual([]);
  }, 600_000);
});
