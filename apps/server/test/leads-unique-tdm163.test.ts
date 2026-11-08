// TDM-163: one lead per email and per repo, enforced by migration 0006's partial unique indexes,
// so concurrent sourcing/import runs can't insert (and later email) the same person twice.
import { MemoryLeadStore, PgLeadStore, importOptinCsv, type NewLead } from "@anybench/outreach";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshMigratedDbTdm11, pgAvailableTdm11, type FreshDbTdm11 } from "./helpers/pg-tdm11.js";

const available = await pgAvailableTdm11();

const lead = (over: Partial<NewLead>): NewLead => ({
  source: "context_dev",
  query: "harness-perf",
  company: null,
  contact: "x",
  email: null,
  githubUrl: null,
  signals: {},
  status: "new",
  ...over,
});

describe.skipIf(!available)("leads uniqueness (TDM-163, local Postgres)", () => {
  let db: FreshDbTdm11;
  let store: PgLeadStore;
  beforeAll(async () => {
    db = await freshMigratedDbTdm11({ max: 10 });
    store = new PgLeadStore({ query: (text, values) => db.pool.query(text, values) });
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  it("concurrent inserts of the same email: exactly one wins, the rest are duplicate_email", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.insert(
          lead({
            email: i % 2 ? "Race@Example.com" : "race@example.com",
            githubUrl: `https://github.com/race/repo-${i}`,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.id)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate === "email")).toHaveLength(7);
    const rows = await db.pool.query(
      "select count(*)::int as n from leads where lower(email) = 'race@example.com'",
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("concurrent inserts of the same repo URL (any case): one wins, the rest are duplicate_repo", async () => {
    const results = await Promise.all(
      [
        "https://github.com/Acme/Tool",
        "https://github.com/acme/tool",
        "https://github.com/ACME/TOOL",
      ].map((u, i) => store.insert(lead({ githubUrl: u, email: `p${i}@acme-repo.example` }))),
    );
    expect(results.filter((r) => r.id)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate === "repo")).toHaveLength(2);
  });

  it("NULL emails and repos never conflict", async () => {
    const a = await store.insert(lead({}));
    const b = await store.insert(lead({}));
    expect(a.id && b.id && a.id !== b.id).toBeTruthy();
  });

  it("two concurrent opt-in imports of the same CSV write each row once", async () => {
    const csv = "name,email,repo\nAda,ada@optin.example,ada/engine\nGrace,grace@optin.example,\n";
    const [r1, r2] = await Promise.all([
      importOptinCsv({ csv, file: "a.csv", store }),
      importOptinCsv({ csv, file: "b.csv", store }),
    ]);
    expect(r1.imported.length + r2.imported.length).toBe(2);
    expect(r1.skipped.length + r2.skipped.length).toBe(2);
    const rows = await db.pool.query(
      "select count(*)::int as n from leads where email in ('ada@optin.example','grace@optin.example')",
    );
    expect(rows.rows[0].n).toBe(2);
  });

  it("matches the MemoryLeadStore semantics", async () => {
    const mem = new MemoryLeadStore();
    for (const s of [store, mem]) {
      const first = await s.insert(
        lead({ email: "same@sem.example", githubUrl: "https://github.com/sem/a" }),
      );
      expect(first.id).toBeDefined();
      expect(await s.insert(lead({ email: "SAME@sem.example" }))).toEqual({ duplicate: "email" });
      expect(await s.insert(lead({ githubUrl: "https://github.com/SEM/A" }))).toEqual({
        duplicate: "repo",
      });
    }
  });

  it("suppressedDomains and domain dedupe read the right columns", async () => {
    await db.pool.query(
      "insert into suppressions (email, reason) values ('gone@supp.example', 'unsubscribe')",
    );
    expect([...(await store.suppressedDomains(["supp.example", "other.example"]))]).toEqual([
      "supp.example",
    ]);
    await store.insert(
      lead({ email: "ceo@taken.example", signals: { contactDomain: "contact.example" } }),
    );
    const ex = await store.existing({
      githubUrls: [],
      domains: ["taken.example", "contact.example", "free.example"],
      emails: [],
    });
    expect([...ex.domains].sort()).toEqual(["contact.example", "taken.example"]);
  });
});
