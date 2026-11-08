// TDM-167 [15.8a]: the account manager role (reply classifier) on FakeNaive.
import { FakeNaive } from "@anybench/naive";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACCOUNT_MANAGER_ROLE,
  ReplyClassificationSchema,
  ReplyClassifierError,
  accountManagerAgentSpec,
  createNaiveReplyClassifier,
  loadAccountManagerOutputJsonSchema,
} from "../src/index.js";

const reply = {
  messageId: "<tdm167-am-1@x>",
  from: "dev@tdm167-am.example",
  subject: "Re: your benchmark",
  text: "Hmm, ping my cofounder about it.",
};

describe("account manager role (TDM-167)", () => {
  it("output.schema.json is the zod schema", () => {
    expect(loadAccountManagerOutputJsonSchema()).toEqual(z.toJSONSchema(ReplyClassificationSchema));
  });

  it("spec: no tools, cheap pinned model, per-task budget", () => {
    const spec = accountManagerAgentSpec();
    expect(spec.role).toBe(ACCOUNT_MANAGER_ROLE);
    expect(spec.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(spec.budget?.maxTaskMicroUsd).toBe(50_000n);
    expect(spec.tools).toEqual({ default_config: { permission: "deny" }, configs: {} });
    expect(spec.system).toContain("never write an answer");
  });

  it("classifies through one Naïve session and reports its cost", async () => {
    const naive = new FakeNaive();
    naive.script(ACCOUNT_MANAGER_ROLE, (ctx) => {
      expect(ctx.input).toEqual({ from: reply.from, subject: reply.subject, text: reply.text });
      return {
        output: { category: "question", reason: "asks to involve a cofounder" },
        costMicroUsd: 3_100n,
      };
    });
    const c = createNaiveReplyClassifier({ naive, budgetMicroUsd: 20_000n });
    expect(c.maxCostMicroUsd).toBe(20_000n);
    const r = await c.classify(reply);
    expect(r).toMatchObject({ category: "question", costMicroUsd: 3_100n });
    expect(naive.spentMicroUsd()).toBe(3_100n);
  });

  it("schema-invalid output is an error that books the spend", async () => {
    const naive = new FakeNaive();
    naive.script(ACCOUNT_MANAGER_ROLE, {
      output: { category: "maybe", reason: "x" },
      costMicroUsd: 900n,
    });
    const c = createNaiveReplyClassifier({ naive, budgetMicroUsd: 20_000n });
    const err = await c.classify(reply).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplyClassifierError);
    expect((err as ReplyClassifierError).costMicroUsd).toBe(900n);
  });

  it("an agent setup failure costs nothing and is retried on the next reply", async () => {
    const naive = new FakeNaive();
    let fail = true;
    const real = naive.agents.findByName.bind(naive.agents);
    naive.agents.findByName = async (name: string) => {
      if (fail) throw new Error("naive unreachable");
      return real(name);
    };
    naive.script(ACCOUNT_MANAGER_ROLE, {
      output: { category: "unclear", reason: "x" },
      costMicroUsd: 500n,
    });
    const c = createNaiveReplyClassifier({ naive, budgetMicroUsd: 20_000n });
    const err = await c.classify(reply).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "agent_setup_failed", costMicroUsd: 0n });
    fail = false;
    expect((await c.classify(reply)).category).toBe("unclear");
  });
});
