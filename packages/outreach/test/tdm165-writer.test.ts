// TDM-165 [15.5a]: writer, draft lint, review store, public_contact import. Offline (FakeNaive).
import { loadWriterOutputJsonSchema } from "@anybench/agents";
import { FakeNaive } from "@anybench/naive";
import { describe, expect, it } from "vitest";
import {
  checkOpening,
  composeDraft,
  importOptinCsv,
  lintDraft,
  MemoryDraftStore,
  MemoryLeadStore,
  MissingPostalAddressError,
  runWriter,
  templateOpening,
  writerOutputJsonSchema,
  type ScoutBriefJson,
} from "../src/index.js";

const POSTAL = "548 Market St, San Francisco, CA 94104";

const brief = (over: Partial<ScoutBriefJson> = {}): ScoutBriefJson => ({
  version: 1,
  lead_id: "lead-1",
  repo_url: "https://github.com/acme/zippy",
  commit: null,
  kind: "agent_harness",
  fit: 90,
  fit_reason: "quantified claims, no gate",
  fit_threshold: 60,
  status: "scored",
  skip_reason: null,
  claims: [
    {
      text: "- **2x faster** than plain Claude Code on our 20-task suite",
      source_ref: "README.md#L7",
      source_url: "https://github.com/acme/zippy/blob/abc/README.md#L7",
      what_it_claims: "speed vs Claude Code",
    },
  ],
  what_we_would_measure: [{ metric: "pass_at_1", label: "pass@1", required: true, why: "w" }],
  gate: ["hidden tests"],
  compared_against: [
    {
      name: "plain Claude Code",
      source: "README.md#L7",
      source_url: "https://github.com/acme/zippy/blob/abc/README.md#L7",
      source_in_repo: true,
      verified: true,
      verified_by: "repo_line",
      why: "named in the README",
    },
    {
      name: "SomethingUnverified",
      source: "https://example.com",
      source_url: "https://example.com/",
      source_in_repo: false,
      verified: false,
      verified_by: null,
      why: "guess",
    },
  ],
  caveats: [],
  contact_ok: true,
  contact: { status: "email_known", reason: "address from public_contact" },
  why: "w",
  dropped: [],
  contact_lookup: null,
  naive: {
    session_id: "s",
    agent_id: "a",
    agent_version: 1,
    model: "m",
    cost_micro_usd: "4000",
    budget_micro_usd: "250000",
  },
  created_at: "2026-11-08T00:00:00.000Z",
  ...over,
});

const lead = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "public_contact",
  company: "Zippy",
  contact: null,
  email: "hello@zippy.dev",
  githubUrl: "https://github.com/acme/zippy",
  signals: {
    provenance: { email: { source: "published_contact", url: "https://zippy.dev/contact" } },
  },
  brief: brief(),
};

describe("writer checks (TDM-165)", () => {
  it("committed writer/output.schema.json is the zod schema's JSON schema", () => {
    expect(loadWriterOutputJsonSchema()).toEqual(writerOutputJsonSchema());
  });

  it("accepts an attributed opening and rejects unmeasured results, invented numbers, URLs, Tandem", () => {
    const b = composeDraft; // keep import used
    expect(typeof b).toBe("function");
    const parsed = { ...lead, brief: brief() } as never;
    const ok = {
      subject: "an independent benchmark of zippy?",
      opening:
        'Your README says zippy is "2x faster" than plain Claude Code on a 20-task suite; I\'d like to check that with hidden tests.',
    };
    const B = runWriterBrief(parsed);
    expect(checkOpening(ok, B, "zippy")).toEqual([]);
    const bad = (opening: string) => checkOpening({ subject: "zippy", opening }, B, "zippy");
    expect(bad("We measured zippy and it is 3x faster than Claude Code.").length).toBeGreaterThan(
      0,
    );
    expect(bad("zippy solved 45 of 50 tasks in our run.").some((i) => i.includes('"45"'))).toBe(
      true,
    );
    expect(
      bad("See zippy.dev for zippy, which we'd like to benchmark.").some((i) => i.includes("URL")),
    ).toBe(true);
    expect(bad("Like Tandem, zippy could use a benchmark.").some((i) => i.includes("Tandem"))).toBe(
      true,
    );
  });

  it("composes a draft with the footer, link and only verified alternatives; lint passes", () => {
    const d = composeDraft(lead as never, templateOpening(runWriterBrief(lead as never), "zippy"), {
      postalAddress: POSTAL,
    });
    expect(d.text).toContain("Hi Zippy team,");
    expect(d.text).toContain("(for zippy: plain Claude Code)");
    expect(d.text).not.toContain("SomethingUnverified");
    expect(d.text).toContain("https://anybench.vercel.app");
    expect(d.text).toContain('Reply "unsubscribe"');
    expect(d.text).toContain(POSTAL);
    expect(d.text).toContain("listed as a contact on zippy.dev");
    expect(d.html).toContain('<a href="https://anybench.vercel.app">');
    expect(lintDraft(d, { postalAddress: POSTAL })).toEqual([]);
    expect(lintDraft(d, { postalAddress: "" })).toContain("COMPANY_POSTAL_ADDRESS is not set");
    expect(
      lintDraft({ ...d, text: d.text.replace(POSTAL, "") }, { postalAddress: POSTAL }),
    ).toContain("the postal address is missing from the footer");
    expect(
      lintDraft(
        { ...d, text: d.text.replace("Hi Zippy team,", "Hi, Tandem beats Claude Code.") },
        { postalAddress: POSTAL },
      ).length,
    ).toBeGreaterThan(0);
    expect(() =>
      composeDraft(lead as never, templateOpening(runWriterBrief(lead as never), "zippy"), {
        postalAddress: " ",
      }),
    ).toThrow(MissingPostalAddressError);
  });

  it("uses the model opening when it passes and falls back to the template when it doesn't", async () => {
    const naive = new FakeNaive();
    naive.script(
      "writer",
      {
        output: {
          subject: "an independent benchmark of zippy?",
          opening:
            'Your README says zippy is "2x faster" than plain Claude Code; I\'d like to check that independently.',
        },
        costMicroUsd: 3_000n,
      },
      {
        output: {
          subject: "zippy",
          opening: "We benchmarked zippy and it is the fastest harness.",
        },
        costMicroUsd: 2_000n,
      },
    );
    const lead2 = { ...lead, id: "22222222-2222-4222-8222-222222222222", email: "team@zippy.dev" };
    const r = await runWriter({ naive, leads: [lead, lead2], postalAddress: POSTAL });
    expect(r.drafts.map((d) => d.openingFrom)).toEqual(["model", "template"]);
    expect(r.drafts[1]!.rejected.length).toBeGreaterThan(0);
    expect(r.drafts.every((d) => d.lint.length === 0)).toBe(true);
    expect(r.spentMicroUsd).toBe(5_000n);
    await expect(runWriter({ naive, leads: [lead], postalAddress: "" })).rejects.toThrow(
      MissingPostalAddressError,
    );
  });
});

describe("review store (TDM-165)", () => {
  it("drafts once per lead, approves with an intervention, rejects, edits back to draft", async () => {
    const store = new MemoryDraftStore([
      { ...lead, status: "scored", fit: 90 },
      {
        ...lead,
        id: "33333333-3333-4333-8333-333333333333",
        email: "x@y.dev",
        status: "skipped",
        brief: brief({ status: "skipped", skip_reason: "contact_not_ok" }),
      },
      {
        ...lead,
        id: "44444444-4444-4444-8444-444444444444",
        email: "z@y.dev",
        status: "skipped",
        brief: brief({ status: "skipped", skip_reason: "no_verified_claims", claims: [] }),
      },
    ]);
    expect((await store.draftable({ limit: 10 })).map((l) => l.id)).toEqual([lead.id]);
    expect((await store.draftable({ limit: 10, allowSkipped: true })).length).toBe(2);
    const r = await runWriter({
      leads: await store.draftable({ limit: 10 }),
      postalAddress: POSTAL,
      noModel: true,
    });
    const id = (await store.insertDraft(lead.id, r.drafts[0]!.draft))!;
    expect(await store.insertDraft(lead.id, r.drafts[0]!.draft)).toBeNull();
    expect((await store.draftable({ limit: 10 })).length).toBe(0);
    expect((await store.get(id.slice(0, 8))).id).toBe(id);
    expect(await store.approve(id, "Jaxon", "founder review")).toBe(true);
    expect(store.interventions[0]).toMatchObject({
      who: "Jaxon",
      what: `approved outreach draft ${id} to hello@zippy.dev`,
    });
    expect(await store.approve(id, "Jaxon", "again")).toBe(false);
    expect(await store.edit(id, { subject: "s", text: "t", html: "h" })).toBe(true);
    expect((await store.get(id)).status).toBe("draft");
    expect(await store.reject(id, "Jaxon", "not a fit")).toBe(true);
    expect(store.leads[0]!.status).toBe("rejected");
    expect(store.interventions).toHaveLength(2);
  });
});

describe("public_contact import (TDM-165)", () => {
  it("needs an https email_source_url and a repo, stores provenance, company = name", async () => {
    const store = new MemoryLeadStore();
    const csv = [
      "name,email,repo,email_source_url,email_snippet",
      "Zippy,Hello@Zippy.dev,acme/zippy,https://zippy.dev/contact,Contact us at hello@zippy.dev",
      "NoUrl,a@b.dev,acme/other,,",
      "NoRepo,c@d.dev,,https://d.dev,",
    ].join("\n");
    const r = await importOptinCsv({ csv, file: "pc.csv", store, source: "public_contact" });
    expect(r.imported).toHaveLength(1);
    expect(r.skipped.map((s) => s.reason)).toEqual(["invalid", "invalid"]);
    const l = store.leads[0]!;
    expect(l).toMatchObject({
      source: "public_contact",
      company: "Zippy",
      contact: null,
      email: "hello@zippy.dev",
    });
    expect((l.signals.provenance as Record<string, unknown>).email).toEqual({
      source: "published_contact",
      url: "https://zippy.dev/contact",
      snippet: "Contact us at hello@zippy.dev",
    });
    await expect(
      importOptinCsv({
        csv: "name,email,repo\nA,a@b.dev,x/y",
        file: "f",
        store,
        source: "public_contact",
      }),
    ).rejects.toThrow(/email_source_url/);
  });
});

import { DraftLeadSchema } from "../src/index.js";
function runWriterBrief(l: never) {
  return DraftLeadSchema.parse(l).brief;
}
