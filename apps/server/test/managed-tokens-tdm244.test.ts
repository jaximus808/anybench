// TDM-244 [20.7]: managed (our) model tokens, billed at cost + MANAGED_TOKEN_MARKUP_BPS, or refused
// for an account with no card. Against local Postgres (skips without it):
//   - the run-terminal hook (ledgerCharges) writes a managed-token trial's usage entry at cost +
//     markup, reading the key's spend again (trialProxySpend) when the trial ended without one,
//     and that entry reaches the Stripe meter like compute;
//   - Go: a no-card account is refused for a kit with a contender on our tokens (402
//     managed_tokens_need_card, in plain words), credit or not; a card lets it go; BYOK kits and
//     the admin comp are unchanged;
//   - the estimate shows "Model tokens (ours)" at cost + 20% and says a card is needed and why;
//   - the budget counts managed tokens at their billed price.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiClientError,
  createApiClient,
  newId,
  PaymentRequiredSchema,
  PROOF_CHECKS,
  TrialIdSchema,
  type ApiClient,
  type KitSpec,
  type PaymentRequired,
} from "@anybench/core";
import type { StripeBillingPort } from "@anybench/billing";
import { loadKit } from "@anybench/kit";
import { FakeProxySpend } from "@anybench/naive";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  billingAccounts,
  contenders,
  kits,
  runs,
  trials,
  usageEntries,
  users,
} from "../src/db/schema/index.js";
import {
  hasCardOnFile,
  MANAGED_TOKENS_NEED_CARD_MESSAGE,
  managedTokensGateDecision,
} from "../src/lib/billing-gate.js";
import { reportUsageToStripe } from "../src/lib/stripe-billing.js";
import { tokenCharge, trialCap, type BudgetPricing } from "../src/orchestrator/budget.js";
import { ledgerCharges } from "../src/orchestrator/defaults.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";
import {
  forceRunStateTdm67,
  kitSpecTdm67,
  runsAppTdm67,
  seedUserTdm67,
  type RunsAppTdm67,
} from "./helpers/runs-tdm67.js";
import { configTdm14 } from "./helpers/server-tdm14.js";

const available = await pgAvailableTdm11();

const BASE = "http://api.test";
const ENV = { ANYBENCH_KEK: "tdm244-test-kek-0123456789abcdefghijklmnop" };
const YEAR_AGO = new Date(Date.now() - 365 * 86_400_000);
const here = path.dirname(fileURLToPath(import.meta.url));
const TANDEM_KIT = path.resolve(here, "../../../kits/tandem-vs-claude-code");

const githubBody = {
  question: "Is ripgrep faster than grep on large trees?",
  source: { kind: "github" as const, github: "BurntSushi/ripgrep", ref: "14.1.1" },
  budget_micro_usd: 50_000_000n,
};

/** The tdm67 kit with two coding-agent contenders reading their tokens from `sources`. */
function agentKit(sources: [string, string]): KitSpec {
  const base = kitSpecTdm67();
  const agent = (id: string, role: string, source: string) => ({
    id,
    role,
    source: { github: "example/agent", ref: id },
    driver: {
      type: "coding-agent",
      verbs: { run: "run {task} {workspace}" },
      model: "claude-opus-5-5",
      env: { CC_SETUP: id, AB_TOKEN_SOURCE: source },
    },
  });
  return {
    ...base,
    repeats: 3,
    contenders: [agent("ours", "subject", sources[0]), agent("byok", "baseline", sources[1])],
  } as unknown as KitSpec;
}

function clientFor(h: RunsAppTdm67, userId: string): ApiClient {
  return createApiClient(
    BASE,
    { kind: "apiKey", key: userId },
    { fetch: (url, init) => Promise.resolve(h.app.request(url, init)) },
  );
}

async function expect402(p: Promise<unknown>): Promise<PaymentRequired> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    const e = err as ApiClientError;
    expect(e.status, e.message).toBe(402);
    return PaymentRequiredSchema.parse(e.body);
  }
  throw new Error("expected HTTP 402");
}

describe("managed tokens: the gate rule and the budget price (TDM-244, pure)", () => {
  const account = (paymentStatus: "none" | "ok" | "past_due" | "blocked", card: boolean) => ({
    paymentStatus,
    hasPaymentMethod: card,
    unbilledMicroUsd: 0n,
    grantedRemainingMicroUsd: 100_000_000n,
    spendLimitMicroUsd: null,
    firstPaidInvoiceAt: null,
  });

  it("our tokens need a card on file, credit or not; BYOK never does", () => {
    expect(managedTokensGateDecision(account("none", false), ["ours"])).toBe(
      "managed_tokens_need_card",
    );
    expect(managedTokensGateDecision(undefined, ["ours"])).toBe("managed_tokens_need_card");
    expect(managedTokensGateDecision(account("ok", true), ["ours"])).toBeNull();
    expect(managedTokensGateDecision(account("none", false), [])).toBeNull();
    // A blocked or past-due account keeps its own reason (the account gate says it).
    expect(managedTokensGateDecision(account("blocked", false), ["ours"])).toBeNull();
    expect(managedTokensGateDecision(account("past_due", true), ["ours"])).toBeNull();
    expect(hasCardOnFile(account("ok", false))).toBe(false);
    expect(MANAGED_TOKENS_NEED_CARD_MESSAGE).toBe(
      "This kit uses Anybench's model tokens. Add your own model key or a card to continue.",
    );
  });

  it("the budget counts our tokens at the billed price (cost + 20%); the free run at cost", async () => {
    const pricing: BudgetPricing = {
      runFeeMicroUsd: 2_000_000n,
      uploadedKitRunFeeMicroUsd: 0n,
      computeMarkupBps: 5000n,
      managedTokenMarkupBps: 2000n,
      blockPriceMicroUsd: 27_600n,
      proxyCapCeilingMicroUsd: 3_000_000n,
    };
    expect(tokenCharge(400_000n, "billed", pricing)).toBe(480_000n);
    expect(tokenCharge(400_000n, "free_run", pricing)).toBe(400_000n);
    // Default markup when the pricing does not say: the config default (2000).
    const { managedTokenMarkupBps: _drop, ...noMarkup } = pricing;
    expect(tokenCharge(400_000n, "billed", noMarkup)).toBe(480_000n);

    // The Tandem kit runs every contender on our tokens: its trial cap is the proxy cap, marked up.
    const kit = await loadKit(TANDEM_KIT);
    const spec = kit.spec;
    const c = spec.contenders[0]!.id;
    const w = spec.workloads[0]!.id;
    const atCost = trialCap(spec, c, w, "free_run", pricing).managedTokens;
    expect(atCost).toBeGreaterThan(0n);
    expect(trialCap(spec, c, w, "billed", pricing).managedTokens).toBe(
      atCost + (atCost * 2000n) / 10_000n,
    );
  });
});

describe.skipIf(!available)("managed tokens on local Postgres (TDM-244)", () => {
  let db: FreshDbTdm11;
  let h: RunsAppTdm67;

  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 4 });
    h = runsAppTdm67(db.url, { env: ENV });
  }, 60_000);

  afterAll(async () => {
    await h?.dbh.close();
    await db?.drop();
  });

  async function newUser(
    app: RunsAppTdm67,
    login: string,
    opts: { age?: Date; card?: boolean; creditMicroUsd?: bigint } = {},
  ): Promise<{ id: string; c: ApiClient; login: string }> {
    const id = await seedUserTdm67(db.db, login);
    await db.db
      .update(users)
      .set({ githubCreatedAt: opts.age ?? YEAR_AGO })
      .where(eq(users.id, id));
    const [u] = await db.db.select().from(users).where(eq(users.id, id));
    const c = clientFor(app, id);
    await c.secrets.put({
      params: { provider: "anthropic" },
      body: { value: "sk-ant-test-0000000000001234" },
    });
    if (opts.card || opts.creditMicroUsd !== undefined) {
      const set = {
        paymentStatus: opts.card ? ("ok" as const) : ("none" as const),
        hasPaymentMethod: opts.card ?? false,
        grantedRemainingMicroUsd: opts.creditMicroUsd ?? 0n,
      };
      await db.db
        .insert(billingAccounts)
        .values({ userId: id, ...set })
        .onConflictDoUpdate({ target: billingAccounts.userId, set });
    }
    return { id, c, login: u!.githubLogin };
  }

  async function runAwaitingGo(c: ApiClient, spec: KitSpec): Promise<string> {
    const run = (await c.runs.create({ body: githubBody })).run;
    await forceRunStateTdm67(db.db, run.id, "awaiting_go", 2_000_000n);
    const [row] = await db.db.select().from(runs).where(eq(runs.id, run.id));
    const proof = PROOF_CHECKS.map((check) => ({
      check,
      pass: true,
      reason: "seeded",
      evidence: [],
    }));
    const [kit] = await db.db
      .insert(kits)
      .values({
        ownerId: row!.ownerId,
        runId: run.id,
        version: 1,
        spec,
        proof,
        hash: "d".repeat(64),
      })
      .returning({ id: kits.id });
    await db.db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, run.id));
    return run.id;
  }

  const MANAGED = agentKit(["naive_proxy", "anthropic_key"]);
  const BYOK = agentKit(["anthropic_key", "anthropic_key"]);

  it("a no-card account is refused at Go for a managed-token kit, credit or not; a card lets it go", async () => {
    const { id, c } = await newUser(h, "mt-nocard", { creditMicroUsd: 100_000_000n });
    const runId = await runAwaitingGo(c, MANAGED);
    const body = await expect402(c.runs.go({ params: { id: runId } }));
    expect(body.reason).toBe("managed_tokens_need_card");
    expect(body.message).toBe(MANAGED_TOKENS_NEED_CARD_MESSAGE);
    expect(body.link_card_url).toContain(`run=${runId}`);
    // The free run never takes our tokens (TDM-223), and says so next to it.
    expect(body.free_run?.reason).toBe("managed_tokens");
    const [still] = await db.db.select().from(runs).where(eq(runs.id, runId));
    expect(still!.state).toBe("awaiting_go");

    await db.db
      .update(billingAccounts)
      .set({ paymentStatus: "ok", hasPaymentMethod: true })
      .where(eq(billingAccounts.userId, id));
    expect((await c.runs.go({ params: { id: runId } })).run.state).toBe("running");
  });

  it("BYOK runs are unchanged: credit still covers a no-card account, none still asks for a card", async () => {
    // A new GitHub account has no free run, so the card gate decides exactly as before.
    const recent = new Date(Date.now() - 86_400_000);
    const credited = await newUser(h, "mt-byok-credit", {
      age: recent,
      creditMicroUsd: 100_000_000n,
    });
    const r1 = await runAwaitingGo(credited.c, BYOK);
    expect((await credited.c.runs.go({ params: { id: r1 } })).run.state).toBe("running");

    const broke = await newUser(h, "mt-byok-none", { age: recent });
    const r2 = await runAwaitingGo(broke.c, BYOK);
    const body = await expect402(broke.c.runs.go({ params: { id: r2 } }));
    expect(body.reason).toBe("no_payment_method");
    expect(body.message).toBeUndefined();
  });

  it("the founder's admin comp is unchanged: a managed-token kit goes, comped", async () => {
    const login = `mt-admin-${Date.now()}`;
    const adminId = await seedUserTdm67(db.db, login);
    const [u] = await db.db.select().from(users).where(eq(users.id, adminId));
    const app = runsAppTdm67(db.url, { env: { ...ENV, ADMIN_GITHUB_LOGINS: u!.githubLogin } });
    try {
      const c = clientFor(app, adminId);
      const runId = await runAwaitingGo(c, MANAGED);
      expect((await c.runs.go({ params: { id: runId } })).run.state).toBe("running");
      const [row] = await db.db.select().from(runs).where(eq(runs.id, runId));
      expect(row!.compedBy).toBe(u!.githubLogin);
    } finally {
      await app.dbh.close();
    }
  });

  it("the estimate shows 'Model tokens (ours)' at cost + 20% and why a card is needed", async () => {
    const { id, c } = await newUser(h, "mt-estimate", { creditMicroUsd: 100_000_000n });
    const runId = await runAwaitingGo(c, MANAGED);
    const { estimate } = await c.runs.estimate({ params: { id: runId } });
    expect(estimate.price).toBe("paid");
    expect(estimate.normal.managed_tokens).toEqual({ contenders: ["ours"], markup_bps: 2000 });
    expect(estimate.tokens.managed_contenders).toEqual(["ours"]);
    expect(estimate.card_needed).toBe(true);
    expect(estimate.card_message).toBe(MANAGED_TOKENS_NEED_CARD_MESSAGE);
    expect(estimate.free_run?.refusal?.reasons.map((r) => r.code)).toContain("managed_tokens");

    await db.db
      .update(billingAccounts)
      .set({ paymentStatus: "ok", hasPaymentMethod: true })
      .where(eq(billingAccounts.userId, id));
    const withCard = (await c.runs.estimate({ params: { id: runId } })).estimate;
    expect(withCard.card_needed).toBe(false);
    expect(withCard.card_message).toBeNull();

    const byokRun = await runAwaitingGo(c, BYOK);
    const byok = (await c.runs.estimate({ params: { id: byokRun } })).estimate;
    expect(byok.normal.managed_tokens).toBeNull();
    expect(byok.card_message).toBeNull();
  });

  /** A delivered run with one done trial per entry of `keys` (null = BYOK). */
  async function deliveredRun(
    ownerId: string,
    keys: ({ keyId: string; stored: number | null } | null)[],
  ): Promise<{ runId: string; trialIds: string[] }> {
    const [run] = await db.db
      .insert(runs)
      .values({ ownerId, question: "q", budgetMicroUsd: 50_000_000n, state: "delivered" })
      .returning();
    const [contender] = await db.db
      .insert(contenders)
      .values({ runId: run!.id, source: "ours", role: "subject", foundBy: "kit" })
      .returning();
    const trialIds: string[] = [];
    for (const [i, k] of keys.entries()) {
      const [t] = await db.db
        .insert(trials)
        .values({
          id: newId(TrialIdSchema),
          ownerId,
          runId: run!.id,
          contenderId: contender!.id,
          workloadId: "w",
          repeat: i,
          state: "done",
          ...(k
            ? {
                proxyKeyId: k.keyId,
                proxyKeyCreatedAt: new Date("2026-11-09T10:00:00.000Z"),
                proxyKeyAttempt: 1,
                metrics:
                  k.stored === null
                    ? { proxy_cost_missing: 1 }
                    : { proxy_cost_micro_usd: k.stored },
              }
            : {}),
        })
        .returning();
      trialIds.push(t!.id);
    }
    return { runId: run!.id, trialIds };
  }

  it("a managed-token trial is billed at cost + markup at run end and reaches the Stripe meter", async () => {
    const { id } = await newUser(h, "mt-meter", { card: true });
    await db.db
      .update(billingAccounts)
      .set({ stripeCustomerId: "cus_tdm244" })
      .where(eq(billingAccounts.userId, id));
    const keyStored = "key_tdm244stored000000000000";
    const keyUnread = "key_tdm244unread000000000000";
    const { runId, trialIds } = await deliveredRun(id, [
      { keyId: keyStored, stored: 1_000_000 },
      { keyId: keyUnread, stored: null },
      null,
    ]);
    // The trial whose spend could not be read when it ended is read again here (trialProxySpend
    // over the credits ledger): two calls, $0.25 in all; another key's call never counts.
    const spend = new FakeProxySpend()
      .add({ actorKeyId: keyUnread, billedMicroUsd: 200_000n, createdAt: "2026-11-09T10:05:00Z" })
      .add({ actorKeyId: keyUnread, billedMicroUsd: 50_000n, createdAt: "2026-11-09T10:06:00Z" })
      .add({ actorKeyId: "key_other", billedMicroUsd: 9_000n, createdAt: "2026-11-09T10:07:00Z" });
    const config = configTdm14(db.url, {});
    expect(config.MANAGED_TOKEN_MARKUP_BPS).toBe(2000n);
    const hook = ledgerCharges(db.db, config, { proxySpend: spend });
    const input = {
      runId,
      userId: id,
      state: "delivered" as const,
      cancelCause: null,
      kitOrigin: "generated" as const,
    };
    await hook.recordRunCharges(input);
    await hook.recordRunCharges(input); // a retried finalize bills nothing twice

    const tokenRows = await db.db.select().from(usageEntries).where(eq(usageEntries.runId, runId));
    const managed = tokenRows.filter((r) => r.type === "managed_tokens");
    expect(managed.map((r) => [r.trialId, r.amountMicroUsd]).sort()).toEqual(
      [
        [trialIds[0], 1_200_000n],
        [trialIds[1], 300_000n],
      ].sort(),
    );

    // The meter reporter sends them like compute: cents = floor(micro / 10_000).
    const meter: { identifier: string; customerId: string; cents: bigint }[] = [];
    const port = {
      mode: "test",
      async reportUsage(e: { identifier: string; customerId: string; cents: bigint }) {
        meter.push(e);
        return "sent" as const;
      },
    } as unknown as StripeBillingPort;
    const out = await reportUsageToStripe(db.db, port);
    expect(out.failed).toBe(0);
    const sent = new Map(meter.map((m) => [m.identifier, m]));
    expect(managed.map((r) => sent.get(r.id)?.cents).sort()).toEqual([120n, 30n].sort());
    for (const row of managed) {
      expect(sent.get(row.id)).toMatchObject({ customerId: "cus_tdm244" });
    }
    const after = await db.db.select().from(usageEntries).where(eq(usageEntries.runId, runId));
    for (const r of after.filter((x) => x.type === "managed_tokens")) {
      expect(r.reportedAt).not.toBeNull();
      expect(r.stripeMeterEventId).toBe(r.id);
    }
  });
});
