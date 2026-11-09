// TDM-212: BYOK model keys. Envelope encryption for user_secrets (lib/byok.ts), and the kit trial
// source handing the run owner's stored Anthropic key to every AB_TOKEN_SOURCE=anthropic_key trial
// (kits/tandem-long-horizon), refusing the trial when there is none. Local Postgres for the DB half.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseKitYaml } from "@anybench/kit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configSecrets, loadConfig } from "../src/config.js";
import { contenders, kits, runs, trials, userSecrets } from "../src/db/schema/index.js";
import {
  ANTHROPIC_PROVIDER,
  byokLookup,
  ByokError,
  openSecret,
  PREVIOUS_KEK_VERSION,
  sealSecret,
  storeUserSecret,
} from "../src/lib/byok.js";
import { ANTHROPIC_KEY_SECRET, kitTrialSource } from "../src/orchestrator/trial-source.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import { seedUserTdm67 } from "./helpers/runs-tdm67.js";

const KEK_TDM212 = "k".repeat(43);
const OTHER_KEK_TDM212 = "o".repeat(43);
// Not a real key: the right shape for the redactors, never sent anywhere.
const FAKE_KEY_TDM212 = "sk-ant-api03-tdm212-not-a-real-key-0000000000000000wxyz";
const OWNER_TDM212 = "11111111-1111-4111-8111-111111111111";

describe("BYOK envelope encryption (TDM-212)", () => {
  const sealed = sealSecret({
    kek: KEK_TDM212,
    ownerId: OWNER_TDM212,
    provider: ANTHROPIC_PROVIDER,
    plaintext: FAKE_KEY_TDM212,
  });

  it("round-trips, and the row holds no plaintext (only the last 4)", () => {
    expect(
      openSecret({
        keks: { current: KEK_TDM212 },
        ownerId: OWNER_TDM212,
        provider: ANTHROPIC_PROVIDER,
        sealed,
      }),
    ).toBe(FAKE_KEY_TDM212);
    expect(sealed.last4).toBe("wxyz");
    expect(JSON.stringify(sealed)).not.toContain("sk-ant-");
    // A fresh data key and IV every time.
    const again = sealSecret({
      kek: KEK_TDM212,
      ownerId: OWNER_TDM212,
      provider: ANTHROPIC_PROVIDER,
      plaintext: FAKE_KEY_TDM212,
    });
    expect(again.ciphertext).not.toBe(sealed.ciphertext);
    expect(again.wrappedDek).not.toBe(sealed.wrappedDek);
  });

  it("refuses a wrong KEK, another owner or provider, and a tampered row", () => {
    const open = (over: Partial<Parameters<typeof openSecret>[0]>) => () =>
      openSecret({
        keks: { current: KEK_TDM212 },
        ownerId: OWNER_TDM212,
        provider: ANTHROPIC_PROVIDER,
        sealed,
        ...over,
      });
    expect(open({ keks: { current: OTHER_KEK_TDM212 } })).toThrow(ByokError);
    expect(open({ ownerId: "22222222-2222-4222-8222-222222222222" })).toThrow(ByokError);
    expect(open({ provider: "openai" })).toThrow(ByokError);
    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(open({ sealed: { ...sealed, ciphertext: flipped.toString("base64") } })).toThrow(
      /does not decrypt/,
    );
    expect(open({ sealed: { ...sealed, kekVersion: 7 } })).toThrow(/no KEK for kek_version 7/);
  });

  it("opens a row still on the previous KEK during a rotation", () => {
    const old = {
      ...sealSecret({
        kek: OTHER_KEK_TDM212,
        ownerId: OWNER_TDM212,
        provider: ANTHROPIC_PROVIDER,
        plaintext: FAKE_KEY_TDM212,
      }),
      kekVersion: PREVIOUS_KEK_VERSION,
    };
    expect(
      openSecret({
        keks: { current: KEK_TDM212, previous: OTHER_KEK_TDM212 },
        ownerId: OWNER_TDM212,
        provider: ANTHROPIC_PROVIDER,
        sealed: old,
      }),
    ).toBe(FAKE_KEY_TDM212);
  });

  it("refuses a short KEK, and no KEK means no lookup at all", () => {
    expect(() =>
      sealSecret({
        kek: "short",
        ownerId: OWNER_TDM212,
        provider: "anthropic",
        plaintext: "x".repeat(20),
      }),
    ).toThrow(/at least 32/);
    expect(byokLookup({} as never, {})).toBeUndefined();
  });

  it("config: ANYBENCH_KEK is optional, at least 32 chars, and redacted like every secret", () => {
    const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };
    expect(loadConfig(base).ANYBENCH_KEK).toBeUndefined();
    const c = loadConfig({ ...base, ANYBENCH_KEK: KEK_TDM212 });
    expect(c.ANYBENCH_KEK).toBe(KEK_TDM212);
    expect(configSecrets(c).ANYBENCH_KEK).toBe(KEK_TDM212);
    expect(() => loadConfig({ ...base, ANYBENCH_KEK: "too-short" })).toThrow(/ANYBENCH_KEK/);
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const LONG_HORIZON_TDM212 = path.resolve(here, "../../../kits/tandem-long-horizon");
const available = await pgAvailableTdm11();

describe.skipIf(!available)("kit trial source: the run owner's BYOK key (TDM-212)", () => {
  let h: FreshDbTdm11;
  beforeAll(async () => {
    h = await freshMigratedDbTdm11();
  }, 60_000);
  afterAll(async () => {
    await h?.drop();
  });

  // The kit as it is stored (JSON: the $25 cap is a plain number there).
  const manifest = path.join(LONG_HORIZON_TDM212, "anybench.yaml");
  const spec = parseKitYaml(readFileSync(manifest, "utf8"), manifest).data;

  async function seedTrial(login: string, contender: "claude-code-solo" | "tandem") {
    const userId = await seedUserTdm67(h.db, login);
    const [run] = await h.db
      .insert(runs)
      .values({ ownerId: userId, question: "q", state: "running", budgetMicroUsd: 1_000_000n })
      .returning();
    const [kit] = await h.db
      .insert(kits)
      .values({
        ownerId: userId,
        runId: run!.id,
        version: 1,
        spec,
        filesUrl: pathToFileURL(LONG_HORIZON_TDM212).href,
        hash: "e".repeat(64),
      })
      .returning();
    await h.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run!.id));
    const [cont] = await h.db
      .insert(contenders)
      .values({
        runId: run!.id,
        source: contender,
        role: "baseline",
        foundBy: "kit",
        status: "kept",
      })
      .returning();
    const [trial] = await h.db
      .insert(trials)
      .values({
        ownerId: userId,
        runId: run!.id,
        contenderId: cont!.id,
        workloadId: "project-tracker",
        repeat: 0,
      })
      .returning();
    const exec = {
      id: trial!.id,
      run_id: run!.id,
      owner_id: userId,
      attempt: 1,
      computer_id: null,
    } as never;
    return { userId, exec };
  }

  it("decrypts the owner's stored key into the trial's ANTHROPIC_API_KEY secret, for A and Tandem", async () => {
    const byok = byokLookup(h.db, { current: KEK_TDM212 })!;
    for (const contender of ["claude-code-solo", "tandem"] as const) {
      const { userId, exec } = await seedTrial(`byok-${contender}`, contender);
      await storeUserSecret(h.db, {
        kek: KEK_TDM212,
        ownerId: userId,
        provider: ANTHROPIC_PROVIDER,
        plaintext: FAKE_KEY_TDM212,
      });
      const p = await kitTrialSource(h.db, { byok }).prepare(exec);
      expect(p.secrets).toEqual({ [ANTHROPIC_KEY_SECRET]: FAKE_KEY_TDM212 });
      // BYOK, not the proxy: no Naïve key is minted, and the key is never in the job's env.
      expect(p.naive_proxy).toBeUndefined();
      expect(p.job.env?.AB_TOKEN_SOURCE).toBe("anthropic_key");
      expect(
        JSON.stringify(p.job, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
      ).not.toContain(FAKE_KEY_TDM212);
      // The runner's spend cap: $25 at Opus 5.5 list prices, and the 3 h cap.
      expect(p.job.token_cap_micro_usd).toBe(25_000_000n);
      expect(p.job.token_prices).toEqual({
        input: 4_000_000n,
        output: 20_000_000n,
        cache_read: 200_000n,
        cache_creation: 5_000_000n,
      });
      expect(p.job.wall_clock_s).toBe(10_800);
      const [row] = await h.db.select().from(userSecrets).where(eq(userSecrets.ownerId, userId));
      expect(row!.lastUsedAt).not.toBeNull();
      expect(row!.ciphertext).not.toContain("sk-ant-");
    }
  });

  it("refuses the trial when the owner has no stored key, or no KEK is configured", async () => {
    const { exec } = await seedTrial("byok-none", "claude-code-solo");
    await expect(
      kitTrialSource(h.db, { byok: byokLookup(h.db, { current: KEK_TDM212 })! }).prepare(exec),
    ).rejects.toThrow(/no stored Anthropic key/);
    await expect(kitTrialSource(h.db, {}).prepare(exec)).rejects.toThrow(/ANYBENCH_KEK is not set/);
  });

  it("re-storing replaces the key (one row per owner and provider)", async () => {
    const { userId, exec } = await seedTrial("byok-rotate", "tandem");
    for (const k of [FAKE_KEY_TDM212, `${FAKE_KEY_TDM212}-v2`])
      await storeUserSecret(h.db, {
        kek: KEK_TDM212,
        ownerId: userId,
        provider: ANTHROPIC_PROVIDER,
        plaintext: k,
      });
    const rows = await h.db.select().from(userSecrets).where(eq(userSecrets.ownerId, userId));
    expect(rows).toHaveLength(1);
    const p = await kitTrialSource(h.db, {
      byok: byokLookup(h.db, { current: KEK_TDM212 })!,
    }).prepare(exec);
    expect(p.secrets[ANTHROPIC_KEY_SECRET]).toBe(`${FAKE_KEY_TDM212}-v2`);
  });
});
