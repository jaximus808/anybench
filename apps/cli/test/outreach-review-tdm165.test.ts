// TDM-165 [15.5a]: `anybench outreach review` needs a person to approve, and refuses lint failures.
import { MemoryDraftStore } from "@anybench/outreach";
import { describe, expect, it } from "vitest";
import { parseEdited, runOutreachReview } from "../src/commands/outreach-review.js";

const POSTAL = "548 Market St, San Francisco, CA 94104";
const text = `Hi team,\n\nHello.\n\nhttps://anybench.vercel.app\n\n--\nReply "unsubscribe" and we won't email you again.\nAnybench, ${POSTAL}\n`;

function setup() {
  const store = new MemoryDraftStore([
    {
      id: "11111111-1111-4111-8111-111111111111",
      email: "a@b.dev",
      githubUrl: "https://github.com/a/b",
      brief: null,
    },
  ]);
  store.messages.push({
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    leadId: "11111111-1111-4111-8111-111111111111",
    kind: "initial",
    status: "draft",
    subject: "an independent benchmark of b?",
    text,
    html: "<p>x</p>",
    approvedBy: null,
    sentAt: null,
    agentmailMessageId: null,
    createdAt: "2026-11-08T00:00:00Z",
  });
  const lines: string[] = [];
  const deps = (ask: string | null) => ({
    env: { COMPANY_POSTAL_ADDRESS: POSTAL },
    stdout: (l: string) => lines.push(l),
    stderr: (l: string) => lines.push(l),
    openStore: async () => ({ store, close: async () => undefined }),
    ask: async () => ask,
  });
  return { store, lines, deps };
}

describe("outreach review (TDM-165)", () => {
  it("approve without a terminal and without --yes refuses", async () => {
    const { store, deps } = setup();
    expect(await runOutreachReview(["approve", "aaaaaaaa", "--by", "Jaxon"], deps(null))).toBe(2);
    expect(store.messages[0]!.status).toBe("draft");
  });
  it("approve with a typed y approves and audits; needs --by", async () => {
    const { store, deps } = setup();
    expect(await runOutreachReview(["approve", "aaaaaaaa"], deps("y"))).toBe(2);
    expect(await runOutreachReview(["approve", "aaaaaaaa", "--by", "Jaxon"], deps("y"))).toBe(0);
    expect(store.messages[0]).toMatchObject({ status: "approved", approvedBy: "Jaxon" });
    expect(store.interventions).toHaveLength(1);
  });
  it("refuses to approve a draft that fails lint", async () => {
    const { store, deps } = setup();
    store.messages[0]!.text = text.replace(POSTAL, "");
    expect(await runOutreachReview(["approve", "aaaaaaaa", "--by", "J", "--yes"], deps("y"))).toBe(
      1,
    );
    expect(store.messages[0]!.status).toBe("draft");
  });
  it("parses an edited file", () => {
    expect(parseEdited("Subject: hi\n\nbody\n\n")).toEqual({ subject: "hi", text: "body\n" });
    expect(parseEdited("no subject")).toBeNull();
  });
});
