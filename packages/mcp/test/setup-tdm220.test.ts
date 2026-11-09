// TDM-220 [19.4]: `npx -y @anybench/mcp setup` registers the server with Claude Code like Tandem's
// setup does, prints the command when `claude` is not on PATH, and never prints the API key.
import { describe, expect, it } from "vitest";
import {
  claudeMcpAddArgs,
  formatClaudeCommand,
  runSetup,
  type CommandResult,
} from "../src/setup.js";
import { main } from "../src/bin.js";

const KEY = `ab_live_${"s".repeat(32)}`;

function harness(
  opts: { claude?: string | null; result?: CommandResult; env?: Record<string, string> } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: { bin: string; args: readonly string[] }[] = [];
  const io = { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
  const deps = {
    env: opts.env ?? {},
    findOnPath: () => (opts.claude === undefined ? "/usr/local/bin/claude" : opts.claude),
    run: async (bin: string, args: readonly string[]) => {
      ran.push({ bin, args });
      return opts.result ?? { code: 0, stdout: "Added stdio MCP server anybench", stderr: "" };
    },
  };
  return { out, err, ran, io, deps };
}

describe("setup (TDM-220)", () => {
  it("runs claude mcp add --scope user anybench -- npx -y @anybench/mcp", async () => {
    const h = harness();
    expect(await runSetup([], h.io, h.deps)).toBe(0);
    expect(h.ran).toEqual([
      {
        bin: "/usr/local/bin/claude",
        args: ["mcp", "add", "--scope", "user", "anybench", "--", "npx", "-y", "@anybench/mcp"],
      },
    ]);
    expect(h.out[0]).toBe(
      "registered: claude mcp add --scope user anybench -- npx -y @anybench/mcp",
    );
    expect(h.out.join("\n")).toMatch(/Set ANYBENCH_API_KEY/);
  });

  it("prints the command when claude is not on PATH, or with --print", async () => {
    const h = harness({ claude: null });
    expect(await runSetup([], h.io, h.deps)).toBe(0);
    expect(h.ran).toEqual([]);
    expect(h.err[0]).toMatch(/`claude` is not on PATH/);
    expect(h.out[0]).toBe("claude mcp add --scope user anybench -- npx -y @anybench/mcp");
    const p = harness();
    expect(await runSetup(["--print", "--scope", "local"], p.io, p.deps)).toBe(0);
    expect(p.ran).toEqual([]);
    expect(p.out[0]).toBe("claude mcp add --scope local anybench -- npx -y @anybench/mcp");
  });

  it("--with-key passes the key to claude mcp add -e but prints it only as $ANYBENCH_API_KEY", async () => {
    const h = harness({ env: { ANYBENCH_API_KEY: KEY } });
    expect(await runSetup(["--with-key"], h.io, h.deps)).toBe(0);
    expect(h.ran[0]!.args).toEqual(claudeMcpAddArgs("user", KEY));
    expect(h.ran[0]!.args).toContain(`ANYBENCH_API_KEY=${KEY}`);
    expect([...h.out, ...h.err].join("\n")).not.toContain(KEY);
    expect(h.out[0]).toContain('-e "ANYBENCH_API_KEY=$ANYBENCH_API_KEY" anybench');
    const none = harness();
    expect(await runSetup(["--with-key"], none.io, none.deps)).toBe(2);
  });

  it("says so when it is already registered, fails on other errors, and checks its flags", async () => {
    const dup = harness({
      result: { code: 1, stdout: "", stderr: "MCP server anybench already exists in user config" },
    });
    expect(await runSetup([], dup.io, dup.deps)).toBe(0);
    expect(dup.out[0]).toMatch(
      /already registered \(scope user\).*claude mcp remove --scope user anybench/,
    );
    const bad = harness({ result: { code: 1, stdout: "", stderr: "boom" } });
    expect(await runSetup([], bad.io, bad.deps)).toBe(1);
    expect(bad.err).toContain("  boom");
    expect(await runSetup(["--scope", "global"], harness().io, harness().deps)).toBe(2);
    expect(await runSetup(["--nope"], harness().io, harness().deps)).toBe(2);
    const sk = harness();
    expect(await runSetup(["--skills"], sk.io, sk.deps)).toBe(0);
    expect(sk.out.at(-1)).toMatch(/arrive with 19\.5/);
    expect(formatClaudeCommand(["mcp", "add", "it's"])).toBe(`claude mcp add 'it'\\''s'`);
  });

  it("the bin answers --version and rejects unknown arguments", async () => {
    expect(await main(["--version"])).toBe(0);
    expect(await main(["--bogus"])).toBe(2);
  });
});
