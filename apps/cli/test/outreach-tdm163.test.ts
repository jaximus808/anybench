import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLeadStore } from "@anybench/outreach";
import { describeDbUrl, runOutreach } from "../src/commands/outreach.js";

const NOW = Date.parse("2026-11-08T02:00:00Z");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

/** Context.dev + GitHub + Monid in one fake; unmatched URLs throw (no network). */
function fakeNet() {
  const calls: string[] = [];
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    const key = `${init?.method ?? "GET"} ${u.host}${u.pathname}`;
    calls.push(key);
    const reply = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers });
    if (key === "POST api.context.dev/v1/web/search") {
      return reply(
        {
          results: [
            {
              url: "https://github.com/acme/fastcli",
              title: "fastcli",
              description: "3x faster than grep",
            },
            { url: "https://github.com/acme/fastcli/issues/1", title: "issue", description: "" },
          ],
        },
        { "x-credits-used": "1" },
      );
    }
    if (key === "GET api.github.com/repos/acme/fastcli") {
      return reply({
        full_name: "acme/fastcli",
        html_url: "https://github.com/acme/fastcli",
        owner: { login: "acme", type: "Organization" },
        homepage: "https://acme.dev",
        stargazers_count: 50,
        pushed_at: "2026-11-01T00:00:00Z",
        default_branch: "main",
      });
    }
    if (key === "GET api.github.com/repos/acme/fastcli/readme") {
      return reply({
        path: "README.md",
        encoding: "base64",
        content: b64("# fastcli\n\n3x faster than ripgrep.\n"),
      });
    }
    throw new Error(`unexpected fetch ${key}`);
  };
  return { fetchFn, calls };
}

describe("anybench outreach", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "tdm163-cli-"));
    dirs.push(d);
    return d;
  };

  it("import requires --source hackathon_optin", async () => {
    const t = io();
    expect(await runOutreach(["import", "x.csv"], t)).toBe(2);
    expect(await runOutreach(["import", "x.csv", "--source", "linkedin"], t)).toBe(2);
    expect(t.err.join("\n")).toMatch(/requires --source hackathon_optin/);
  });

  it("imports an opt-in CSV into the store", async () => {
    const dir = tmp();
    const file = join(dir, "optin.csv");
    writeFileSync(file, "name,email,repo\nAda,ada@example.com,ada/engine\nBad,nope,\n");
    const store = new MemoryLeadStore();
    const t = io();
    const code = await runOutreach(
      [
        "import",
        file,
        "--source",
        "hackathon_optin",
        "--database-url",
        "postgres://u:secret@db.local:5432/x",
      ],
      {
        ...t,
        openStore: async () => ({ store, close: async () => {} }),
      },
    );
    expect(code).toBe(0);
    expect(t.out[0]).toBe("imported 1 of 2 rows (source=hackathon_optin)");
    expect(t.err.join("\n")).not.toContain("secret");
    expect(store.leads[0]).toMatchObject({ source: "hackathon_optin", email: "ada@example.com" });
  });

  it("source validates its flags", async () => {
    const t = io();
    expect(await runOutreach(["source", "--limit", "3"], t)).toBe(2);
    expect(await runOutreach(["source", "--query", "harness-perf"], t)).toBe(2);
    expect(await runOutreach(["source", "--query", "harness-perf", "--limit", "x"], t)).toBe(2);
    expect(
      await runOutreach(
        ["source", "--query", "harness-perf", "--limit", "1", "--monid-cap-micro-usd", "1.5"],
        t,
      ),
    ).toBe(2);
  });

  it("source runs a saved query end to end against fakes and writes a lead", async () => {
    const net = fakeNet();
    const store = new MemoryLeadStore();
    const t = io();
    const code = await runOutreach(
      [
        "source",
        "--query",
        "cli-faster",
        "--limit",
        "5",
        "--cache-dir",
        tmp(),
        "--credit-cap",
        "3",
      ],
      {
        ...t,
        env: { CONTEXT_DEV_API_KEY: "ctx_test" },
        fetch: net.fetchFn,
        now: () => NOW,
        openStore: async () => ({ store, close: async () => {} }),
      },
    );
    expect(code).toBe(0);
    expect(store.leads).toHaveLength(1);
    expect(store.leads[0]).toMatchObject({
      source: "context_dev",
      query: "cli-faster",
      githubUrl: "https://github.com/acme/fastcli",
      company: "acme",
      email: null,
      status: "new",
    });
    expect(t.out[0]).toMatch(
      /^wrote 1 leads \(0 with email\), skipped 1, stopped by queries_exhausted$/,
    );
    expect(t.out[1]).toMatch(/1 Context\.dev credits, 2 GitHub calls, \$0\.0000 Monid/);
    expect(net.calls.some((c) => c.includes("monid"))).toBe(false);
  });

  it("never prints database credentials", () => {
    expect(describeDbUrl("postgres://anybench:pw@localhost:55432/anybench")).toBe(
      "localhost:55432/anybench",
    );
  });
});
