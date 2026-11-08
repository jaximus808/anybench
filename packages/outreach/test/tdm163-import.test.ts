import { describe, expect, it } from "vitest";
import { MemoryLeadStore, importOptinCsv, parseCsv } from "../src/index.js";

const NOW = Date.parse("2026-11-08T03:00:00Z");

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF, BOM and blank lines", () => {
    expect(
      parseCsv('\uFEFFname,email\r\n"Lovelace, Ada","a@x.io"\r\n\r\n"say ""hi""",b@x.io\n'),
    ).toEqual([
      ["name", "email"],
      ["Lovelace, Ada", "a@x.io"],
      ['say "hi"', "b@x.io"],
    ]);
    expect(() => parseCsv('a,"b')).toThrow(/unterminated/);
  });
});

describe("importOptinCsv", () => {
  const csv = [
    "Email,Name,Repo",
    "Ada@Example.com,Ada Lovelace,https://github.com/ada/engine",
    "grace@example.com,Grace Hopper,grace/cobol-agent",
    "bad-email,Bad Row,ada/x",
    "linus@example.com,Linus,https://gitlab.com/linus/git",
    "nobody@example.com,,",
    "ada@example.com,Ada again,",
    "opted-out@example.com,Opted Out,oo/repo",
    "dup-repo@example.com,Dup Repo,https://github.com/Existing/Repo",
    "norepo@example.com,No Repo,",
  ].join("\n");

  it("imports name,email,repo rows with provenance and skips the rest with reasons", async () => {
    const store = new MemoryLeadStore({
      suppressions: ["opted-out@example.com"],
      leads: [
        {
          source: "context_dev",
          query: "harness-perf",
          company: null,
          contact: "e",
          email: null,
          githubUrl: "https://github.com/existing/repo",
          signals: {},
          status: "new",
        },
      ],
    });
    const r = await importOptinCsv({ csv, file: "optin.csv", store, now: () => NOW });
    expect(r.rows).toBe(9);
    expect(r.imported.map((i) => [i.row, i.email, i.githubUrl])).toEqual([
      [2, "ada@example.com", "https://github.com/ada/engine"],
      [3, "grace@example.com", "https://github.com/grace/cobol-agent"],
      [10, "norepo@example.com", null],
    ]);
    expect(r.skipped.map((s) => [s.row, s.reason])).toEqual([
      [4, "invalid"],
      [5, "invalid"],
      [6, "invalid"],
      [7, "duplicate_email"],
      [8, "suppressed"],
      [9, "duplicate_repo"],
    ]);
    expect(r.skipped[0]!.detail).toMatch(/email/);
    expect(r.skipped[1]!.detail).toMatch(/not a GitHub repo/);

    const ada = store.leads.find((l) => l.email === "ada@example.com")!;
    expect(ada).toMatchObject({
      source: "hackathon_optin",
      contact: "Ada Lovelace",
      status: "new",
      query: null,
      signals: {
        provenance: {
          source: "hackathon_optin",
          file: "optin.csv",
          row: 2,
          importedAt: "2026-11-08T03:00:00.000Z",
        },
      },
    });
  });

  it("dedupes against leads already in the store and supports a dry run", async () => {
    const store = new MemoryLeadStore();
    await importOptinCsv({ csv, file: "optin.csv", store });
    const again = await importOptinCsv({ csv, file: "optin.csv", store, dryRun: true });
    expect(again.imported).toHaveLength(0);
    expect(again.skipped.filter((s) => s.reason === "duplicate_email")).toHaveLength(6);
    expect(store.leads).toHaveLength(5); // no suppressions or existing repo in this store
  });

  it("requires the name,email,repo header", async () => {
    await expect(
      importOptinCsv({ csv: "name,email\nA,a@x.io", file: "x.csv", store: new MemoryLeadStore() }),
    ).rejects.toThrow(/missing: repo/);
  });
});
