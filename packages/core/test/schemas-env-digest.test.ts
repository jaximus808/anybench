// TDM-7: EnvSpec and ProjectDigest schemas.
import { describe, expect, it } from "vitest";
import {
  EnvSpecSchema,
  ProjectDigestSchema,
  formatSchemaIssues,
  resolveEnvProvider,
  type ProjectDigestInput,
} from "../src/index.js";

describe("EnvSpec", () => {
  const svcEnv = {
    profile: "svc",
    resources: { vcpu: 4, memory_gb: 8, disk_gb: 40 },
    recipes: ["postgres16", "redis7"],
    network: { allow: ["registry.npmjs.org", "*.pypi.org", "localhost:5432"] },
    healthchecks: [{ id: "pg", command: "pg_isready -h localhost" }],
  };

  it("parses with defaults and resolves the provider", () => {
    const env = EnvSpecSchema.parse(svcEnv);
    expect(env.resources.gpu).toBe(0);
    expect(env.os_packages).toEqual([]);
    expect(env.healthchecks[0]).toEqual({
      id: "pg",
      command: "pg_isready -h localhost",
      timeout_s: 60,
      retries: 0,
    });
    expect(resolveEnvProvider(env)).toBe("naive");
    expect(
      resolveEnvProvider(
        EnvSpecSchema.parse({ ...svcEnv, resources: { vcpu: 32, memory_gb: 64, disk_gb: 100 } }),
      ),
    ).toBe("vm");
    expect(resolveEnvProvider(EnvSpecSchema.parse({ ...svcEnv, profile: "gui" }))).toBe("vm");
  });

  it("refuses Naïve for machines it cannot run", () => {
    const r = EnvSpecSchema.safeParse({
      ...svcEnv,
      provider: "naive",
      resources: { vcpu: 4, memory_gb: 8, disk_gb: 40, gpu: 1 },
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(formatSchemaIssues(r.error)[0]).toMatch(
        /^provider: profile 'svc' .* needs provider 'vm'/,
      );
  });

  it("rejects bad hosts, duplicate recipes and relative fixture destinations", () => {
    const r = EnvSpecSchema.safeParse({
      ...svcEnv,
      recipes: ["postgres16", "postgres16"],
      network: { allow: ["https://evil.example.com/"] },
      fixtures: [{ src: "data/", dest: "home/naive/data" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const errors = formatSchemaIssues(r.error);
      expect(errors.some((e) => e.startsWith("network.allow[0]:"))).toBe(true);
      expect(errors.some((e) => e.startsWith("fixtures[0].dest:"))).toBe(true);
    }
    const dup = EnvSpecSchema.safeParse({ ...svcEnv, recipes: ["postgres16", "postgres16"] });
    expect(dup.success).toBe(false);
    if (!dup.success)
      expect(formatSchemaIssues(dup.error)).toEqual([
        "recipes: recipe 'postgres16' is listed twice",
      ]);
  });
});

describe("ProjectDigest", () => {
  const digest: ProjectDigestInput = {
    source: {
      kind: "github",
      url: "https://github.com/jaximus808/tandem",
      ref: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    name: "tandem",
    kind: "harness",
    summary: "Shared task board for agent swarms.",
    languages: [{ name: "TypeScript", bytes: 420_000 }],
    entrypoints: [{ kind: "bin", name: "tandem-mcp", command: "npx -y @jaximus/tandem-mcp" }],
    test_commands: ["pnpm test"],
    claude_code: { claude_md: true, mcp_servers: ["tandem"] },
    files: { count: 312, total_bytes: 1_900_000 },
    suggested_driver_types: ["harness", "coding-agent"],
    ingested_at: "2026-11-07T21:30:00Z",
    hash: "b".repeat(64),
  };

  it("parses a GitHub digest", () => {
    const d = ProjectDigestSchema.parse(digest);
    expect(d.releases).toEqual({ tags: [] });
    expect(d.claude_code?.agents).toEqual([]);
  });

  it("parses binary and Claude Code setup sources", () => {
    expect(
      ProjectDigestSchema.parse({
        ...digest,
        source: { kind: "binary", url: "https://example.com/x.tar.gz", sha256: "c".repeat(64) },
      }).source,
    ).toMatchObject({ kind: "binary", docs: [] });
    expect(
      ProjectDigestSchema.safeParse({
        ...digest,
        source: { kind: "claude-code-setup", files: ["CLAUDE.md", ".mcp.json"] },
      }).success,
    ).toBe(true);
  });

  it("rejects bad fields with paths", () => {
    const r = ProjectDigestSchema.safeParse({
      ...digest,
      source: { kind: "github", url: "https://gitlab.com/x/y", ref: "main", commit: "abc" },
      suggested_driver_types: ["gui"],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const errors = formatSchemaIssues(r.error);
      expect(errors.some((e) => e.startsWith("source.url:"))).toBe(true);
      expect(errors.some((e) => e.startsWith("source.commit:"))).toBe(true);
      expect(errors.some((e) => e.startsWith("suggested_driver_types[0]:"))).toBe(true);
    }
  });
});
