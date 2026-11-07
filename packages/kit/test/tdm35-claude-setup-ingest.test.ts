import { fileURLToPath } from "node:url";
import { ProjectDigestSchema } from "@anybench/core";
import { describe, expect, it } from "vitest";
import {
  ClaudeSetupIngestError,
  ClaudeSetupIngestResultSchema,
  ingestClaudeSetup,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/tdm35-claude-setup", import.meta.url));
const FIXED_NOW = () => new Date("2026-11-07T12:00:00Z");

// Planted in the synthetic fixture; none of them may survive ingest.
const PLANTED = [
  "sk-ant-api03-TDM35FAKEkeyNOTreal0000000000000000", // CLAUDE.md text + .mcp.json env
  "tdm35-not-a-real-github-token-777", // .mcp.json env, also pasted into CLAUDE.md
  "tdm35-bearer-value-xyz789", // .mcp.json Authorization header
  "acme-tdm35-settings-token-0001", // .claude/settings.json env
];

describe("ingestClaudeSetup on the .claude/ bundle fixture", () => {
  it("builds a harness digest listing agents, skills, commands and MCP servers", async () => {
    const res = await ingestClaudeSetup({ dir: FIXTURE, name: "acme-harness" }, { now: FIXED_NOW });
    expect(ClaudeSetupIngestResultSchema.parse(res)).toEqual(res);
    const d = ProjectDigestSchema.parse(res.digest);
    expect(d.kind).toBe("harness");
    expect(d.name).toBe("acme-harness");
    expect(d.source).toEqual({
      kind: "claude-code-setup",
      files: [
        "CLAUDE.md",
        ".mcp.json",
        ".claude/agents/planner.md",
        ".claude/agents/reviewer.md",
        ".claude/commands/db/migrate.md",
        ".claude/commands/ship.md",
        ".claude/settings.json",
        ".claude/skills/release-notes/SKILL.md",
      ],
    });
    expect(d.claude_code).toEqual({
      claude_md: true,
      agents: ["planner", "reviewer"],
      skills: ["release-notes"],
      commands: ["db:migrate", "ship"],
      mcp_servers: ["github", "claude-proxy", "docs"],
    });
    expect(d.entrypoints).toEqual([
      { kind: "agent", name: "planner", path: ".claude/agents/planner.md" },
      { kind: "agent", name: "reviewer", path: ".claude/agents/reviewer.md" },
    ]);
    expect(d.suggested_driver_types).toEqual(["harness", "coding-agent"]);
    expect(d.docs).toEqual(["CLAUDE.md", ".claude/skills/release-notes/SKILL.md"]);
    expect(d.summary).toBe(
      "Claude Code setup with CLAUDE.md: 2 agents (planner, reviewer), 1 skill (release-notes), " +
        "2 commands (db:migrate, ship), 3 MCP servers (github, claude-proxy, docs).",
    );
    expect(d.files.count).toBe(8);
    expect(res.agents[0]?.description).toBe("Splits work into tickets and dispatches them.");
    expect(res.mcp_servers).toEqual([
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env_keys: ["GITHUB_PERSONAL_ACCESS_TOKEN", "DEBUG"],
        header_keys: [],
      },
      {
        name: "claude-proxy",
        transport: "stdio",
        command: "node",
        args: ["proxy.js"],
        env_keys: ["ANTHROPIC_API_KEY"],
        header_keys: [],
      },
      {
        name: "docs",
        transport: "http",
        url: "https://docs.example.com/mcp",
        args: [],
        env_keys: [],
        header_keys: ["Authorization"],
      },
    ]);
  });

  it("redacts every planted secret, including .mcp.json env values of any length", async () => {
    const res = await ingestClaudeSetup({ dir: FIXTURE }, { now: FIXED_NOW });
    const all = JSON.stringify(res);
    for (const s of PLANTED) expect(all).not.toContain(s);

    const file = (p: string) => res.files.find((f) => f.path === p)?.text ?? "";
    // Exact matches on .mcp.json values win over the generic key pattern, and keep their name.
    expect(file("CLAUDE.md")).toContain("[REDACTED:MCP_CLAUDE_PROXY_ANTHROPIC_API_KEY]");
    expect(file("CLAUDE.md")).toContain("[REDACTED:MCP_GITHUB_GITHUB_PERSONAL_ACCESS_TOKEN]");
    const mcp = JSON.parse(file(".mcp.json")) as {
      mcpServers: Record<
        string,
        { env?: Record<string, string>; headers?: Record<string, string> }
      >;
    };
    expect(mcp.mcpServers.github?.env).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: "[REDACTED:MCP_GITHUB_GITHUB_PERSONAL_ACCESS_TOKEN]",
      DEBUG: "[REDACTED:MCP_GITHUB_DEBUG]",
    });
    expect(mcp.mcpServers.docs?.headers).toEqual({
      Authorization: "[REDACTED:MCP_DOCS_HEADER_AUTHORIZATION]",
    });
    const settings = JSON.parse(file(".claude/settings.json")) as { env: Record<string, string> };
    expect(settings.env).toEqual({
      NODE_ENV: "test",
      ACME_API_TOKEN: "[REDACTED:ACME_API_TOKEN]",
    });
    // The original bytes are hashed, not returned.
    expect(res.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256))).toBe(true);
  });

  it("redacts caller-supplied secrets that match no known pattern", async () => {
    const token = "tdm35-staging-token-abcdef123456";
    const plain = await ingestClaudeSetup({ dir: FIXTURE });
    expect(JSON.stringify(plain)).toContain(token); // not a known key shape
    const res = await ingestClaudeSetup({ dir: FIXTURE }, { secrets: { STAGING_TOKEN: token } });
    expect(JSON.stringify(res)).not.toContain(token);
    expect(res.files.find((f) => f.path === ".claude/agents/reviewer.md")?.text).toContain(
      "[REDACTED:STAGING_TOKEN]",
    );
  });

  it("hashes the tree stably and changes the hash when a file changes", async () => {
    const a = await ingestClaudeSetup({ files: { "CLAUDE.md": "# a\n" }, name: "x" });
    const b = await ingestClaudeSetup({ files: { "CLAUDE.md": "# a\n" }, name: "x" });
    const c = await ingestClaudeSetup({ files: { "CLAUDE.md": "# b\n" }, name: "x" });
    expect(a.digest.hash).toBe(b.digest.hash);
    expect(a.digest.hash).not.toBe(c.digest.hash);
  });
});

describe("ingestClaudeSetup from an in-memory upload", () => {
  it("keeps only setup paths, skips binaries, and rejects unsafe paths", async () => {
    const res = await ingestClaudeSetup({
      name: "upload",
      files: {
        ".claude/agents/solo.md": "Do the thing.",
        ".claude/skills/blob/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
        "src/index.ts": "export {};",
      },
    });
    expect(res.digest.claude_code).toMatchObject({ claude_md: false, agents: ["solo"] });
    expect(res.digest.summary).toContain("without CLAUDE.md");
    expect(res.skipped).toEqual([
      { path: "src/index.ts", reason: "not part of a Claude Code setup" },
      { path: ".claude/skills/blob/logo.png", reason: "binary file" },
    ]);
    await expect(
      ingestClaudeSetup({ name: "evil", files: { "../.mcp.json": "{}" } }),
    ).rejects.toMatchObject({ code: "bad_path" });
  });

  it("redacts short env values in place only, and catches unknown keys by pattern", async () => {
    const res = await ingestClaudeSetup({
      name: "short",
      files: {
        ".mcp.json": JSON.stringify({ mcpServers: { x: { command: "x", env: { DEBUG: "1" } } } }),
        "CLAUDE.md": "Step 1: never paste sk-ant-api03-ANOTHERfakeKEY999 here.",
      },
    });
    const claude = res.files.find((f) => f.path === "CLAUDE.md")?.text;
    expect(claude).toBe("Step 1: never paste [REDACTED:ANTHROPIC_API_KEY] here.");
    expect(res.files.find((f) => f.path === ".mcp.json")?.text).toContain("[REDACTED:MCP_X_DEBUG]");
  });

  it("refuses an upload with no Claude Code setup in it", async () => {
    await expect(
      ingestClaudeSetup({ name: "empty", files: { "README.md": "hi" } }),
    ).rejects.toBeInstanceOf(ClaudeSetupIngestError);
    await expect(ingestClaudeSetup({ dir: "/nonexistent-tdm35" })).rejects.toMatchObject({
      code: "empty_setup",
    });
  });
});
