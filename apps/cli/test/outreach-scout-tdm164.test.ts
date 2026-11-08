// TDM-164 [15.3a]: `anybench outreach scout`. Offline: FakeNaive, in-memory store and ingest.
import type { RepoIngest } from "@anybench/kit";
import { FakeNaive } from "@anybench/naive";
import { MemoryScoutLeadStore } from "@anybench/outreach";
import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { runOutreachScout } from "../src/commands/outreach-scout.js";

const README = "# tool\n\nRuns 3x faster than grep on the linux tree, same matches.\n";

function tdm164CliIngest(url: string): RepoIngest {
  return {
    digest: {
      source: { kind: "github", url, ref: "main", commit: "f".repeat(40) },
      name: "tool",
      kind: "software",
      summary: "a search tool",
      languages: [],
      entrypoints: [],
      build_commands: [],
      test_commands: [],
      docs: [],
      releases: { tags: [] },
      files: { count: 1, total_bytes: 10 },
      suggested_driver_types: [],
      ingested_at: "2026-11-08T00:00:00.000Z",
      hash: "b".repeat(64),
    },
    context: {
      tree: { paths: ["README.md"], dirs: [], truncated: false },
      readme: { path: "README.md", text: README, truncated: false },
      manifests: [],
      tests: { files: 0, dirs: [], sample: [] },
      benchmarks: { files: 0, dirs: [], sample: [] },
      commits_scanned: 0,
      recent_test_commits: [],
      large_files: [],
    },
  };
}

const output = {
  kind: "cli",
  fit: 75,
  fit_reason: "A quantified speed claim against grep and no published harness.",
  claims: [
    {
      text: "Runs 3x faster than grep on the linux tree",
      source_ref: "README.md#L3",
      what_it_claims: "The README says it is 3x faster than grep.",
      about: "own",
    },
  ],
  what_we_would_measure: [
    { metric: "startup_time", why: "To check whether startup explains the gap." },
  ],
  gate: ["Byte-identical match output against GNU grep on every workload."],
  compared_against: [{ name: "GNU grep", source: "README.md#L3", why: "The README names grep." }],
  caveats: [],
  contact_ok: true,
  why: "It claims 3x over grep; we'd check it with a byte-identical match gate.",
};

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
  };
}

describe("anybench outreach scout", () => {
  it("scouts DB leads, writes briefs and prints the spend", async () => {
    const naive = new FakeNaive();
    naive.scriptDefault("scout", { output, costMicroUsd: 12_345n });
    const store = new MemoryScoutLeadStore([{ id: "l1", githubUrl: "https://github.com/o/tool" }]);
    const c = io();
    const code = await runOutreachScout(["--limit", "5"], {
      ...c.deps,
      env: { OUTREACH_FIT_THRESHOLD: "60" },
      naive,
      openStore: async () => ({ store, close: async () => undefined }),
      ingest: async (url) => tdm164CliIngest(url),
    });
    expect(code).toBe(0);
    expect(store.leads[0]).toMatchObject({ status: "scored", fit: 75 });
    expect(c.out[0]).toMatch(
      /^l1\thttps:\/\/github.com\/o\/tool\tscored fit 75 · 1 cited claims\t\$0\.0123/,
    );
    expect(c.out.at(-1)).toMatch(/spend \$0\.0123 of \$3\.0000 cap \(Naïve \$0\.0123, email lookups \$0\.0000\) \(per lead \$0\.2500\)/);
  });

  it("--repo runs ad hoc without a database and --json prints micro-USD as strings", async () => {
    const naive = new FakeNaive();
    naive.scriptDefault("scout", { output, costMicroUsd: 1_000n });
    const c = io();
    const code = await runOutreachScout(["--repo", "https://github.com/o/tool", "--json"], {
      ...c.deps,
      env: {},
      naive,
      openStore: async () => {
        throw new Error("must not open the DB");
      },
      ingest: async (url) => tdm164CliIngest(url),
    });
    expect(code).toBe(0);
    const report = JSON.parse(c.out.join("\n")) as {
      spentMicroUsd: string;
      results: Array<{ leadId: string; brief: { claims: Array<{ source_url: string }> } }>;
    };
    expect(report.spentMicroUsd).toBe("1000");
    expect(report.results[0]!.leadId).toBe("repo:o/tool");
    expect(report.results[0]!.brief.claims[0]!.source_url).toBe(
      `https://github.com/o/tool/blob/${"f".repeat(40)}/README.md#L3`,
    );
  });

  it("refuses bad money flags and a missing key", async () => {
    const c = io();
    expect(await runOutreachScout(["--budget-micro-usd", "0.25"], { ...c.deps, env: {} })).toBe(2);
    expect(
      await runOutreachScout(["--budget-micro-usd", "5000000", "--run-cap-micro-usd", "1000000"], {
        ...c.deps,
        env: { NAIVE_API_KEY: "x" },
      }),
    ).toBe(2);
    expect(await runOutreachScout([], { ...c.deps, env: {} })).toBe(2);
    expect(c.err.join("\n")).toMatch(/NAIVE_API_KEY is not set/);
  });

  it("is dispatched from main", async () => {
    const code = await main(["outreach", "scout", "--help"]);
    expect(code).toBe(0);
  });
});
