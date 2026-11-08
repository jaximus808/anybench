// run-email: the run-owner email (lib/run-email.ts) and the run.notify job (jobs/run-notify.ts).
// Renderer tests use the report of a real delivered run (test/fixtures/run-email-report.json);
// job tests run on local Postgres with a fake mailer (skipped without Postgres).
import { readFileSync } from "node:fs";
import { ReportSchema, type Report, type RunId, type RunState } from "@anybench/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { reports, runs, users } from "../src/db/schema/index.js";
import { appendEvents } from "../src/lib/events.js";
import { JOBS } from "../src/jobs/index.js";
import {
  maskEmail,
  notifySettings,
  RUN_NOTIFY_JOB,
  runNotifyEnqueuer,
  runNotifyJobKey,
  sendRunNotification,
  type RunMail,
  type RunMailer,
} from "../src/jobs/run-notify.js";
import type { JobQueue } from "../src/lib/job-queue.js";
import { oneLineVerdict, renderRunEmail, splitAnswer } from "../src/lib/run-email.js";
import { orchestratorStore, stateChangedEvent } from "../src/orchestrator/store.js";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const REPORT: Report = ReportSchema.parse(
  JSON.parse(readFileSync(new URL("./fixtures/run-email-report.json", import.meta.url), "utf8")),
);
const RUN_ID = REPORT.run_id as string;
const QUESTION =
  "Is Tandem ×3 faster or cheaper than plain Claude Code at finishing coding tasks correctly?\n\nPreferences:\n- Send results to: email";

describe("run email rendering", () => {
  const base = {
    runId: RUN_ID,
    question: QUESTION,
    webUrl: "https://anybench.vercel.app/",
    postalAddress: "1 Main St, St. Louis, MO 63130",
  };

  it("delivered: subject is a verbatim prefix of the report's verdict, never a winner", () => {
    const { headline } = splitAnswer(REPORT.answer);
    const verdict = oneLineVerdict(headline);
    expect(verdict).toBe(
      "tandem vs claude-code-solo: no detectable difference at n=3 tasks (4 vs 7 trials)",
    );
    expect(REPORT.answer).toContain(verdict);
    const m = renderRunEmail({
      ...base,
      state: "delivered",
      report: REPORT,
      reason: null,
      nothingBilled: true,
    });
    expect(m.subject).toBe(`Your Anybench result: ${verdict}`);
    expect(m.subject).not.toMatch(/\b(wins|winner|better|faster)\b/i);
  });

  it("delivered: headline, per-setup table, scope, button, evaluation line, address", () => {
    const m = renderRunEmail({
      ...base,
      state: "delivered",
      report: REPORT,
      reason: null,
      nothingBilled: true,
    });
    const url = `https://anybench.vercel.app/runs/${RUN_ID}`;
    for (const part of [m.html, m.text]) {
      expect(part).toContain(url);
      expect(part).toContain("Is Tandem ×3 faster or cheaper than plain Claude Code");
      expect(part).not.toContain("Preferences:");
      expect(part).toContain("A · Claude Code solo");
      expect(part).toContain("Tandem ×3");
      expect(part).toContain("100%");
      expect(part).toContain("50%");
      expect(part).toContain("3 tasks: this doesn");
      expect(part).toContain("1 Main St, St. Louis, MO 63130");
      expect(part).toContain("How it was evaluated");
      expect(part).toContain("the same 3 tasks (todo-api, auth-refactor, bug-hunt)");
      expect(part).toContain("Proof: curated (verified offline at bebb77e)");
    }
    expect(m.html).toContain("View the full report");
    // The verdict text appears verbatim (HTML-escaped) in the body.
    const { headline } = splitAnswer(REPORT.answer);
    expect(m.text).toContain(
      headline.slice(0, headline.length - REPORT.per_task!.scope.length).trim(),
    );
    // Wall time and cost have no gated value in this run: no column for them.
    expect(m.html).not.toContain("Wall time");
    expect(m.html).not.toContain("<script");
  });

  it("escapes HTML from report text", () => {
    const evil = { ...REPORT, answer: "<img src=x onerror=alert(1)> wins" };
    const m = renderRunEmail({
      ...base,
      state: "delivered",
      report: evil,
      reason: null,
      nothingBilled: false,
    });
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;img src=x");
  });

  it("short emails say what happened and whether anything was billed", () => {
    const failed = renderRunEmail({
      ...base,
      state: "failed",
      report: null,
      reason: "env build failed: npm ci exited 1",
      nothingBilled: true,
    });
    expect(failed.subject).toBe("Your Anybench run failed");
    expect(failed.text).toContain("env build failed: npm ci exited 1");
    expect(failed.text).toContain("Nothing was billed for this run.");
    const held = renderRunEmail({
      ...base,
      state: "needs_human",
      report: null,
      reason: "needs hardware: a GPU",
      nothingBilled: true,
    });
    expect(held.subject).toBe("Your Anybench run needs your input");
    expect(held.text).toContain("Nothing is billed while it waits.");
    expect(held.html).toContain("Open the run");
    const ours = renderRunEmail({
      ...base,
      state: "cancelled",
      report: null,
      reason: "kill switch global: maintenance",
      nothingBilled: true,
    });
    expect(ours.subject).toBe("Your Anybench run was stopped");
    expect(ours.text).toContain("Nothing was billed");
    const billed = renderRunEmail({
      ...base,
      state: "failed",
      report: null,
      reason: null,
      nothingBilled: false,
    });
    expect(billed.text).not.toContain("Nothing was billed");
  });
});

describe("notify settings", () => {
  const cfg = (env: Record<string, string>) => loadConfig({ LOG_LEVEL: "silent", ...env });
  it("on by default when Monid and an inbox are configured; the flag turns it off", () => {
    expect(notifySettings(cfg({})).enabled).toBe(false);
    const on = notifySettings(cfg({ MONID_API_KEY: "k", OUTREACH_FROM_ADDRESS: "a@agentmail.to" }));
    expect(on).toMatchObject({
      enabled: true,
      inbox: "a@agentmail.to",
      webUrl: "https://anybench.vercel.app",
    });
    expect(
      notifySettings(
        cfg({
          MONID_API_KEY: "k",
          OUTREACH_FROM_ADDRESS: "a@agentmail.to",
          NOTIFY_EMAIL_ENABLED: "0",
        }),
      ).enabled,
    ).toBe(false);
    expect(
      notifySettings(
        cfg({
          MONID_API_KEY: "k",
          NOTIFY_FROM_INBOX: "n@agentmail.to",
          OUTREACH_FROM_ADDRESS: "a@agentmail.to",
        }),
      ).inbox,
    ).toBe("n@agentmail.to");
  });
  it("registers run.notify and masks addresses in logs", () => {
    expect(JOBS.map((j) => j.name)).toContain(RUN_NOTIFY_JOB);
    expect(maskEmail("jaxon@example.com")).toBe("j…@example.com");
    expect(runNotifyJobKey(RUN_ID, "delivered")).toBe(`run-notify:${RUN_ID}:delivered`);
    expect(runNotifyJobKey(RUN_ID, "delivered").startsWith("runs:")).toBe(false);
  });
});

class FakeMailerRunEmail implements RunMailer {
  sent: RunMail[] = [];
  failNext = false;
  async send(mail: RunMail) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("monid 503");
    }
    this.sent.push(mail);
    return { messageId: `msg-${this.sent.length}` };
  }
}

const available = await pgAvailableTdm11();

describe.skipIf(!available)("run.notify job (local Postgres)", () => {
  let fresh: FreshDbTdm11;
  let gh = 9_700_000;
  beforeAll(async () => {
    fresh = await freshMigratedDbTdm11({ max: 4 });
  }, 60_000);
  afterAll(async () => {
    await fresh?.drop();
  });

  async function seed(
    state: RunState,
    opts: { email?: string | null; cancelCause?: "user" | "ours"; report?: boolean } = {},
  ) {
    const [u] = await fresh.db
      .insert(users)
      .values({
        githubLogin: `notify-${gh}`,
        githubId: gh++,
        email: opts.email === undefined ? "owner@example.com" : opts.email,
      })
      .returning();
    const [run] = await fresh.db
      .insert(runs)
      .values({
        ownerId: u!.id,
        question: QUESTION,
        budgetMicroUsd: 5_000_000n,
        state,
        ...(opts.cancelCause ? { cancelCause: opts.cancelCause } : {}),
        ...(state === "needs_human" ? { pausedReason: "needs hardware: a GPU" } : {}),
      })
      .returning();
    if (opts.report)
      await fresh.db.insert(reports).values({
        ownerId: u!.id,
        runId: run!.id,
        json: { ...REPORT, run_id: run!.id },
        md: "# report",
      });
    return run!.id;
  }

  const deps = (mailer: RunMailer) => ({
    db: fresh.db,
    mailer,
    webUrl: "https://anybench.vercel.app",
    postalAddress: "1 Main St",
  });

  it("delivered: one email to the owner, exactly once", async () => {
    const id = await seed("delivered", { report: true });
    const mailer = new FakeMailerRunEmail();
    const a = await sendRunNotification(deps(mailer), { run_id: id, state: "delivered" });
    expect(a.kind).toBe("sent");
    const b = await sendRunNotification(deps(mailer), { run_id: id, state: "delivered" });
    expect(b).toEqual({ kind: "skipped", reason: "already sent" });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("owner@example.com");
    expect(mailer.sent[0]!.subject).toMatch(
      /^Your Anybench result: tandem vs claude-code-solo: no detectable difference/,
    );
    expect(mailer.sent[0]!.text).toContain(`https://anybench.vercel.app/runs/${id}`);
    const [row] = await fresh.db.select().from(runs).where(eq(runs.id, id));
    expect(
      (row!.stageOutputs as { notified: Record<string, unknown> }).notified.delivered,
    ).toMatchObject({
      message_id: "msg-1",
    });
  });

  it("a failed send releases the claim so the retry sends", async () => {
    const id = await seed("delivered", { report: true });
    const mailer = new FakeMailerRunEmail();
    mailer.failNext = true;
    await expect(
      sendRunNotification(deps(mailer), { run_id: id, state: "delivered" }),
    ).rejects.toThrow("monid 503");
    expect((await sendRunNotification(deps(mailer), { run_id: id, state: "delivered" })).kind).toBe(
      "sent",
    );
    expect(mailer.sent).toHaveLength(1);
  });

  it("skips: no owner email, a user's own cancel, a run that moved on", async () => {
    const mailer = new FakeMailerRunEmail();
    const noEmail = await seed("delivered", { email: null, report: true });
    expect(
      await sendRunNotification(deps(mailer), { run_id: noEmail, state: "delivered" }),
    ).toEqual({
      kind: "skipped",
      reason: "owner has no email",
    });
    const userCancel = await seed("cancelled", { cancelCause: "user" });
    expect(
      (await sendRunNotification(deps(mailer), { run_id: userCancel, state: "cancelled" })).kind,
    ).toBe("skipped");
    const moved = await seed("running");
    expect(
      (await sendRunNotification(deps(mailer), { run_id: moved, state: "needs_human" })).kind,
    ).toBe("skipped");
    expect(mailer.sent).toHaveLength(0);
  });

  it("needs_human, failed (ours) and cancelled (ours): short emails, nothing billed", async () => {
    const mailer = new FakeMailerRunEmail();
    const held = await seed("needs_human");
    await sendRunNotification(deps(mailer), { run_id: held, state: "needs_human" });
    expect(mailer.sent.at(-1)!.text).toContain("needs hardware: a GPU");

    const failed = await seed("failed");
    await fresh.db
      .update(runs)
      .set({ stageOutputs: { failure: { stage: "env_build", reason: "npm ci exited 1" } } })
      .where(eq(runs.id, failed));
    // No trials: a failed run with no subject failure bills nothing (pricing runFeeDecision).
    await sendRunNotification(deps(mailer), { run_id: failed, state: "failed" });
    expect(mailer.sent.at(-1)!.subject).toBe("Your Anybench run failed");
    expect(mailer.sent.at(-1)!.text).toContain("npm ci exited 1");
    expect(mailer.sent.at(-1)!.text).toContain("Nothing was billed for this run.");

    const ours = await seed("cancelled", { cancelCause: "ours" });
    await appendEvents(fresh.db, ours as RunId, [
      stateChangedEvent(
        ours,
        { kind: "worker", id: "w1" },
        "running",
        "cancelled",
        "cancel",
        "kill switch global: maintenance",
      ),
    ]);
    await sendRunNotification(deps(mailer), { run_id: ours, state: "cancelled" });
    expect(mailer.sent.at(-1)!.subject).toBe("Your Anybench run was stopped");
    expect(mailer.sent.at(-1)!.text).toContain("kill switch global: maintenance");
    expect(mailer.sent.at(-1)!.text).toContain("Nothing was billed");
    expect(mailer.sent).toHaveLength(3);
  });

  it("the orchestrator enqueues run.notify in the state change's transaction", async () => {
    const id = await seed("analyzing");
    const owner = "w1~1~abc";
    await fresh.db.update(runs).set({ advanceLeaseOwner: owner }).where(eq(runs.id, id));
    const added: { task: string; payload: Record<string, unknown>; jobKey: string }[] = [];
    const queue: JobQueue = {
      async add(_tx, task, payload, o) {
        added.push({ task, payload, jobKey: o.jobKey });
      },
    };
    const store = orchestratorStore(fresh.db, {
      maxTickAgeMs: 60_000,
      onStateChange: runNotifyEnqueuer(queue),
    });
    expect(await store.commit(id, owner, "analyzing", { type: "advance" })).toBe("ok");
    expect(added).toEqual([
      {
        task: RUN_NOTIFY_JOB,
        payload: { run_id: id, state: "delivered" },
        jobKey: `run-notify:${id}:delivered`,
      },
    ]);
  });
});
