// TDM-178 [16.7]: a kit with a micro-USD cap (`token_cap_micro_usd`, a bigint once parsed) can be
// stored, hashed and rerun, and a run can carry such a contender. Before the fix, JSON.stringify
// threw on the bigint and every one of these routes answered 500.
import { apiRoutes, KitSpecSchema, type KitSpec } from "@anybench/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contenders, kits } from "../src/db/schema/index.js";
import { canonicalJson, kitSpecHash } from "../src/routes/kits.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  forceRunStateTdm67,
  kitSpecTdm67,
  runsAppTdm67,
  seedUserTdm67,
  type RunsAppTdm67,
} from "./helpers/runs-tdm67.js";

const available = await pgAvailableTdm11();
const BASE_TDM178 = "http://api.test";

/** The TDM-67 cli kit with its baseline swapped for a coding agent capped at $5 of spend. */
function cappedSpecTdm178(): Record<string, unknown> {
  const spec = kitSpecTdm67() as unknown as Record<string, unknown> & { contenders: unknown[] };
  spec.contenders[1] = {
    id: "claude-code",
    role: "baseline",
    source: { upload: ["CLAUDE.md"] },
    driver: {
      type: "coding-agent",
      verbs: { run: "adapters/claude-code/driver.sh run {task} {workspace}" },
      model: "claude-sonnet-4-5-20250929",
      token_cap_micro_usd: "5000000",
    },
  };
  return spec;
}

async function rawTdm178(
  h: RunsAppTdm67,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await h.app.request(`${BASE_TDM178}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : undefined, text };
}

describe.skipIf(!available)("kits and runs with a bigint micro-USD cap (TDM-178)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;
  let alice: string;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url);
    alice = await seedUserTdm67(db.db, "alice-tdm178");
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  it("canonicalJson writes a bigint as its decimal string, so the hash survives a round trip", () => {
    const parsed: KitSpec = KitSpecSchema.parse(cappedSpecTdm178());
    expect(canonicalJson({ a: 5_000_000n })).toBe('{"a":"5000000"}');
    const roundTripped = KitSpecSchema.parse(JSON.parse(canonicalJson(parsed)));
    expect(kitSpecHash(roundTripped)).toBe(kitSpecHash(parsed));
  });

  it("creates a run with the capped contender, a kit version, and a rerun of that kit", async () => {
    const spec = cappedSpecTdm178();
    const created = await rawTdm178(h, alice, "POST", "/runs", {
      question: "Does the capped agent keep up with ripgrep?",
      source: { kind: "github", github: "BurntSushi/ripgrep", ref: "14.1.1" },
      budget_micro_usd: "5000000",
      contenders: [(spec.contenders as unknown[])[1]],
    });
    expect(created.status, created.text).toBe(201);
    const runId = (created.json as { run: { id: string } }).run.id;
    const cs = await db.db.select().from(contenders).where(eq(contenders.runId, runId));
    expect(cs).toHaveLength(1);
    expect(JSON.parse(cs[0]!.source)).toMatchObject({
      driver: { token_cap_micro_usd: "5000000" },
    });

    await forceRunStateTdm67(db.db, runId, "kit_draft");
    const v1 = await rawTdm178(h, alice, "PATCH", `/runs/${runId}/kit`, { spec });
    expect(v1.status, v1.text).toBe(201);
    const kit = apiRoutes.kits.createVersion.response.parse(v1.json).kit;
    expect(kit.spec.contenders[1]!.driver).toMatchObject({ token_cap_micro_usd: 5_000_000n });
    expect(kit.hash).toBe(kitSpecHash(KitSpecSchema.parse(spec)));
    const [row] = await db.db.select().from(kits).where(eq(kits.id, kit.id));
    expect(row!.spec).toMatchObject({
      contenders: [{}, { driver: { token_cap_micro_usd: "5000000" } }],
    });

    // A rerun copies the stored spec into version 1 of a new run (runs.ts insert path).
    const rerun = await rawTdm178(h, alice, "POST", "/runs", {
      question: "Rerun the capped kit",
      source: { kind: "kit", kit_id: kit.id },
      budget_micro_usd: "1000000",
    });
    expect(rerun.status, rerun.text).toBe(201);
    const rerunKitId = (rerun.json as { run: { kit_id: string } }).run.kit_id;
    const got = await rawTdm178(h, alice, "GET", `/kits/${rerunKitId}`);
    expect(got.status, got.text).toBe(200);
    const k2 = apiRoutes.kits.get.response.parse(got.json).kit;
    expect(k2.spec.contenders[1]!.driver).toMatchObject({ token_cap_micro_usd: 5_000_000n });
    expect(k2.hash).toBe(kit.hash);
  });
});
