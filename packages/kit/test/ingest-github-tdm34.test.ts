// TDM-34 [4.2]: GitHub / local repo ingest. No network: a tiny git repo in a temp dir stands in for
// GitHub (fetched over file://), plus the committed digest fixtures.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectDigestSchema, redactJson } from "@anybench/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IngestError,
  REPO_INGEST_MAX_BYTES,
  RepoIngestSchema,
  ingestGitHubRepo,
  ingestLocalRepo,
  ingestRepo,
  isBenchPath,
  isTestPath,
  parseGitHubUrl,
  serializeRepoIngest,
} from "../src/index.js";

const FAKE_PAT = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const EXACT_TOKEN = "tdm34-exact-token-value-9f8e7d";
const NOW = () => new Date("2026-11-07T12:00:00.000Z");

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Tdm Test",
  GIT_AUTHOR_EMAIL: "tdm34@example.com",
  GIT_COMMITTER_NAME: "Tdm Test",
  GIT_COMMITTER_EMAIL: "tdm34@example.com",
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function commitAll(root: string, msg: string, date: string): void {
  sh(root, "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", msg], {
    cwd: root,
    env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

let base: string;
let repo: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "anybench-tdm34-"));
  repo = join(base, "widget");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "uploadpack.allowFilter", "true");
  write(
    repo,
    "package.json",
    JSON.stringify({
      name: "widget",
      description: "A tiny widget CLI for tests",
      bin: { widget: "./bin/widget.js" },
      scripts: { build: "tsc", test: "vitest run" },
      devDependencies: { vitest: "^1" },
    }),
  );
  write(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(
    repo,
    "README.md",
    `# widget\n\n[![ci](https://x/badge.svg)](https://x)\n\nWidget turns text into widgets quickly.\n\nToken in docs by mistake: ${FAKE_PAT} and ${EXACT_TOKEN}\n`,
  );
  write(repo, "bin/widget.js", "#!/usr/bin/env node\nconsole.log('w')\n");
  write(repo, "src/index.ts", "export const x = 1;\n".repeat(20));
  write(repo, "tests/widget.test.ts", "it('a', () => {});\n");
  write(repo, "bench/widget.bench.ts", "bench('a', () => {});\n");
  write(repo, "CLAUDE.md", "# rules\n");
  write(repo, ".claude/agents/reviewer.md", "---\nname: reviewer\n---\n");
  write(repo, ".mcp.json", JSON.stringify({ mcpServers: { tandem: { command: "x" } } }));
  write(repo, "docs/guide.md", "# guide\n");
  commitAll(repo, "initial", "2026-01-01T10:00:00+00:00");
  sh(repo, "tag", "v0.9.0");
  sh(repo, "tag", "v1.0.0");
  write(repo, "tests/widget.test.ts", "it('a', () => {});\nit('b', () => {});\n");
  write(repo, "src/index.ts", "export const x = 2;\n");
  commitAll(repo, "fix off-by-one, add regression test", "2026-01-02T10:00:00+00:00");
  sh(repo, "tag", "v1.1.0-beta.1");
  write(repo, "src/other.ts", "export const y = 1;\n");
  commitAll(repo, "refactor", "2026-01-03T10:00:00+00:00");
  sh(repo, "remote", "add", "origin", "git@github.com:acme/widget.git");
  // Uncommitted work must be ignored.
  write(repo, "UNCOMMITTED.md", "not in HEAD\n");
}, 60_000);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("parseGitHubUrl", () => {
  it("accepts the common spellings", () => {
    const want = "https://github.com/sharkdp/hyperfine";
    for (const s of [
      "https://github.com/sharkdp/hyperfine",
      "https://github.com/sharkdp/hyperfine.git",
      "github.com/sharkdp/hyperfine/",
      "git@github.com:sharkdp/hyperfine.git",
      "ssh://git@github.com/sharkdp/hyperfine",
      "sharkdp/hyperfine",
    ]) {
      expect(parseGitHubUrl(s).url).toBe(want);
    }
    expect(parseGitHubUrl("https://github.com/a/b/tree/release/1.x").ref).toBe("release/1.x");
    expect(parseGitHubUrl("a/b#v1.2.0").ref).toBe("v1.2.0");
    expect(parseGitHubUrl("a/b@main").ref).toBe("main");
  });

  it("rejects non-GitHub input", () => {
    for (const s of ["https://gitlab.com/a/b", "not a url", "https://github.com/onlyowner"]) {
      expect(() => parseGitHubUrl(s)).toThrow(IngestError);
    }
  });
});

describe("path classification", () => {
  it("spots tests and benchmarks", () => {
    expect(isTestPath("tests/integration.rs")).toBe(true);
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("pkg/x_test.go")).toBe(true);
    expect(isTestPath("node_modules/a/test/x.js")).toBe(false);
    expect(isTestPath("src/main.rs")).toBe(false);
    expect(isBenchPath("benches/parse.rs")).toBe(true);
    expect(isBenchPath("src/x.bench.ts")).toBe(true);
    expect(isBenchPath("src/benchmark/mod.rs")).toBe(true);
  });
});

// Git-heavy: generous timeouts, the shared machine runs many workers at once.
const SLOW = { timeout: 60_000 };

describe("ingestLocalRepo", SLOW, () => {
  it("digests HEAD read-only, with a valid ProjectDigest", async () => {
    const statusBefore = sh(repo, "status", "--porcelain");
    const indexBefore = statSync(join(repo, ".git", "index")).mtimeMs;
    const head = sh(repo, "rev-parse", "HEAD").trim();

    const r = await ingestLocalRepo(repo, { now: NOW, githubToken: EXACT_TOKEN });

    expect(RepoIngestSchema.safeParse(r).success).toBe(true);
    expect(ProjectDigestSchema.safeParse(r.digest).success).toBe(true);
    expect(r.digest.source).toEqual({
      kind: "github",
      url: "https://github.com/acme/widget",
      ref: "main",
      commit: head,
    });
    expect(r.digest.name).toBe("widget");
    expect(r.digest.summary).toBe("A tiny widget CLI for tests");
    expect(r.digest.ingested_at).toBe("2026-11-07T12:00:00.000Z");
    expect(r.digest.releases).toEqual({
      latest: "v1.0.0",
      tags: ["v1.1.0-beta.1", "v1.0.0", "v0.9.0"],
    });
    expect(r.digest.build_commands).toEqual(["pnpm install", "pnpm run build"]);
    expect(r.digest.test_commands).toEqual(["pnpm test"]);
    expect(r.digest.entrypoints).toContainEqual({
      kind: "bin",
      name: "widget",
      command: "widget",
      path: "bin/widget.js",
    });
    expect(r.digest.suggested_driver_types[0]).toBe("cli");
    expect(r.digest.claude_code).toEqual({
      claude_md: true,
      agents: ["reviewer"],
      skills: [],
      commands: [],
      mcp_servers: ["tandem"],
    });
    expect(r.digest.docs).toContain("README.md");
    expect(r.digest.docs).toContain("docs/guide.md");
    expect(r.digest.languages.map((l) => l.name)).toContain("TypeScript");
    expect(r.digest.hash).toMatch(/^[a-f0-9]{64}$/);

    expect(r.context.tree.paths).not.toContain("UNCOMMITTED.md");
    expect(r.context.tree.paths).toContain("src/other.ts");
    expect(r.context.readme?.path).toBe("README.md");
    expect(r.context.manifests.map((m) => m.path)).toEqual(["package.json"]);
    expect(r.context.tests).toMatchObject({ files: 1, dirs: ["tests"] });
    expect(r.context.benchmarks).toMatchObject({ files: 1, dirs: ["bench"] });
    expect(r.context.commits_scanned).toBe(3);
    // The initial commit is the root, not a shallow boundary, so it counts too.
    expect(r.context.recent_test_commits.map((c) => c.subject)).toEqual([
      "fix off-by-one, add regression test",
      "initial",
    ]);
    expect(r.context.recent_test_commits[0]?.test_files).toEqual(["tests/widget.test.ts"]);

    // Secrets: pattern and exact value both redacted.
    const text = serializeRepoIngest(r).toString("utf8");
    expect(text).not.toContain(FAKE_PAT);
    expect(text).not.toContain(EXACT_TOKEN);
    expect(text).toContain("[REDACTED:GITHUB_TOKEN]");

    // Same tree, same hash.
    const again = await ingestLocalRepo(repo, { now: NOW });
    expect(again.digest.hash).toBe(r.digest.hash);

    // Nothing in the repo changed.
    expect(statSync(join(repo, ".git", "index")).mtimeMs).toBe(indexBefore);
    expect(sh(repo, "status", "--porcelain")).toBe(statusBefore);
  });

  it("reads an older rev", async () => {
    const r = await ingestLocalRepo(repo, { now: NOW, rev: "v1.0.0" });
    expect(r.digest.source.kind === "github" && r.digest.source.ref).toBe("v1.0.0");
    expect(r.context.tree.paths).not.toContain("src/other.ts");
    expect(r.context.commits_scanned).toBe(1);
  });

  it("needs a github remote or an explicit githubUrl", async () => {
    const bare = join(base, "noremote");
    mkdirSync(bare);
    sh(bare, "init", "-q", "-b", "trunk");
    write(bare, "main.go", "package main\n");
    write(bare, "go.mod", "module example.com/tool\n\ngo 1.22\n");
    commitAll(bare, "go", "2026-01-01T10:00:00+00:00");

    await expect(ingestLocalRepo(bare)).rejects.toMatchObject({ code: "no_github_remote" });
    const r = await ingestLocalRepo(bare, { githubUrl: "acme/tool", now: NOW });
    expect(r.digest.source).toMatchObject({ url: "https://github.com/acme/tool", ref: "trunk" });
    expect(r.digest.build_commands).toEqual(["go build ./..."]);
    expect(r.digest.test_commands).toEqual(["go test ./..."]);
    expect(r.digest.entrypoints).toContainEqual({
      kind: "bin",
      name: "tool",
      command: "tool",
      path: "main.go",
    });
  });

  it("rejects a non-repo", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    await expect(ingestLocalRepo(plain)).rejects.toMatchObject({ code: "not_a_repo" });
    await expect(ingestLocalRepo(join(base, "missing"))).rejects.toMatchObject({
      code: "not_a_repo",
    });
  });

  it("shrinks the tree to fit the byte budget", async () => {
    const big = join(base, "big");
    mkdirSync(big);
    sh(big, "init", "-q", "-b", "main");
    for (let i = 0; i < 150; i++)
      write(big, `src/module_${i}/file_with_a_long_name_${i}.py`, `x = ${i}\n`);
    commitAll(big, "many files", "2026-01-01T10:00:00+00:00");
    const r = await ingestLocalRepo(big, { githubUrl: "acme/big", maxBytes: 10_000, now: NOW });
    expect(serializeRepoIngest(r).length).toBeLessThanOrEqual(10_000);
    expect(r.context.tree.truncated).toBe(true);
    expect(r.digest.files.count).toBe(150);
  });
});

describe("ingestGitHubRepo (fetched over file://, no network)", SLOW, () => {
  it("fetches shallow + partial and digests the default branch", async () => {
    const r = await ingestGitHubRepo("https://github.com/acme/widget", {
      cloneUrl: `file://${repo}`,
      now: NOW,
    });
    expect(RepoIngestSchema.safeParse(r).success).toBe(true);
    expect(r.digest.source).toEqual({
      kind: "github",
      url: "https://github.com/acme/widget",
      ref: "main",
      commit: sh(repo, "rev-parse", "HEAD").trim(),
    });
    expect(r.digest.releases.latest).toBe("v1.0.0");
    expect(r.digest.releases.tags).toHaveLength(3);
    expect(r.context.commits_scanned).toBe(3);
    // Same tree as the local read.
    expect(r.digest.hash).toBe((await ingestLocalRepo(repo, { now: NOW })).digest.hash);
  });

  it("skips the shallow boundary commit and honours a ref", async () => {
    const r = await ingestGitHubRepo("acme/widget#v1.1.0-beta.1", {
      cloneUrl: `file://${repo}`,
      depth: 1,
      now: NOW,
    });
    expect(r.digest.source).toMatchObject({ ref: "v1.1.0-beta.1" });
    expect(r.context.commits_scanned).toBe(1);
    expect(r.context.recent_test_commits).toEqual([]);
    expect(r.context.tree.paths).not.toContain("src/other.ts");
  });

  it("ingestRepo routes local dirs and URLs", async () => {
    const local = await ingestRepo(repo, { now: NOW });
    const remote = await ingestRepo("acme/widget", { cloneUrl: `file://${repo}`, now: NOW });
    expect(local.digest.hash).toBe(remote.digest.hash);
  });

  it("reports fetch failures as IngestError without the token", async () => {
    const err = await ingestGitHubRepo("acme/widget", {
      cloneUrl: `file://${join(base, "does-not-exist")}`,
      githubToken: EXACT_TOKEN,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).code).toBe("git_failed");
    expect(String((err as Error).message)).not.toContain(EXACT_TOKEN);
  });
});

describe("committed digest fixtures", () => {
  const dir = fileURLToPath(new URL("../fixtures/digests/", import.meta.url));
  for (const [name, url] of [
    ["agentcanvas", "https://github.com/jaximus808/tandem"],
    ["hyperfine", "https://github.com/sharkdp/hyperfine"],
  ] as const) {
    it(`${name}.json is a valid, redacted digest under 200 KB`, () => {
      const bytes = readFileSync(join(dir, `${name}.json`));
      expect(bytes.length).toBeLessThan(REPO_INGEST_MAX_BYTES);
      const parsed = RepoIngestSchema.parse(JSON.parse(bytes.toString("utf8")));
      expect(ProjectDigestSchema.parse(parsed.digest).source).toMatchObject({
        kind: "github",
        url,
      });
      expect(parsed.digest.files.count).toBeGreaterThan(0);
      expect(parsed.context.tree.paths.length).toBeGreaterThan(0);
      expect(parsed.context.readme?.text.length ?? 0).toBeGreaterThan(0);
      expect(parsed.context.recent_test_commits.length).toBeGreaterThan(0);
      // Redacting again changes nothing: no known secret pattern is left in the fixture.
      expect(redactJson(parsed)).toEqual(parsed);
    });
  }
});
