// `npx -y @anybench/mcp setup` (TDM-220 [19.4]), like Tandem's: register the server with Claude
// Code (`claude mcp add --scope user anybench -- npx -y @anybench/mcp`), or print that command
// when `claude` is not on PATH. Skill installation is 19.5's (`--skills` is a stub until then).
//
// The API key is not written into Claude Code's config unless --with-key is given: by default the
// server reads ANYBENCH_API_KEY from the environment Claude Code starts it in. With --with-key the
// key goes to `claude mcp add -e` as an argument and is printed only redacted.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { API_KEY_PATTERN, MCP_PACKAGE, MCP_SERVER_NAME } from "@anybench/core";

export const SETUP_SCOPES = ["user", "local", "project"] as const;
export type SetupScope = (typeof SETUP_SCOPES)[number];

export const SETUP_USAGE = `Usage: npx -y ${MCP_PACKAGE} setup [--scope user|local|project] [--with-key] [--print] [--skills]

Register the Anybench MCP server with Claude Code:
  claude mcp add --scope user ${MCP_SERVER_NAME} -- npx -y ${MCP_PACKAGE}

Options:
  --scope <s>   Claude Code config scope (default user: every project)
  --with-key    also store $ANYBENCH_API_KEY in that config (claude mcp add -e); default: the
                server reads ANYBENCH_API_KEY from the environment Claude Code runs in
  --print       print the command instead of running it
  --skills      install the /anybench skills (arrives with 19.5; does nothing yet)
  -h, --help`;

export interface SetupIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SetupDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** Absolute path of `name` on PATH, or null. */
  findOnPath?: (name: string) => string | null;
  run?: (bin: string, args: readonly string[]) => Promise<CommandResult>;
}

const defaultIo: SetupIo = {
  stdout: (l) => process.stdout.write(`${l}\n`),
  stderr: (l) => process.stderr.write(`${l}\n`),
};

export function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function runCommand(bin: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: null, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The `claude mcp add` arguments. `key` is passed with -e when given. */
export function claudeMcpAddArgs(scope: SetupScope, key?: string): string[] {
  return [
    "mcp",
    "add",
    "--scope",
    scope,
    ...(key !== undefined ? ["-e", `ANYBENCH_API_KEY=${key}`] : []),
    MCP_SERVER_NAME,
    "--",
    "npx",
    "-y",
    MCP_PACKAGE,
  ];
}

const shellQuote = (a: string) =>
  /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;

/** The command as a line to print, the key shown as $ANYBENCH_API_KEY. */
export function formatClaudeCommand(args: readonly string[]): string {
  return [
    "claude",
    ...args.map((a) =>
      a.startsWith("ANYBENCH_API_KEY=") ? '"ANYBENCH_API_KEY=$ANYBENCH_API_KEY"' : shellQuote(a),
    ),
  ].join(" ");
}

export async function runSetup(
  argv: readonly string[],
  io: SetupIo = defaultIo,
  deps: SetupDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  let scope: SetupScope = "user";
  let withKey = false;
  let print = false;
  let skills = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      io.stdout(SETUP_USAGE);
      return 0;
    } else if (a === "--with-key") withKey = true;
    else if (a === "--print") print = true;
    else if (a === "--skills") skills = true;
    else if (a === "--scope" || a.startsWith("--scope=")) {
      const v = a === "--scope" ? argv[++i] : a.slice("--scope=".length);
      if (!(SETUP_SCOPES as readonly string[]).includes(v ?? "")) {
        io.stderr(`setup: --scope must be one of ${SETUP_SCOPES.join(", ")}`);
        return 2;
      }
      scope = v as SetupScope;
    } else {
      io.stderr(`setup: unknown argument: ${a}`);
      io.stderr(SETUP_USAGE);
      return 2;
    }
  }

  let key: string | undefined;
  if (withKey) {
    key = env.ANYBENCH_API_KEY?.trim();
    if (!key || !API_KEY_PATTERN.test(key)) {
      io.stderr("setup: --with-key needs ANYBENCH_API_KEY set to an ab_live_… / ab_test_… key");
      return 2;
    }
  }
  const args = claudeMcpAddArgs(scope, key);
  const line = formatClaudeCommand(args);
  const claude = (deps.findOnPath ?? ((n: string) => findOnPath(n, env)))("claude");

  if (print || claude === null) {
    if (claude === null)
      io.stderr("setup: `claude` is not on PATH; run this once Claude Code is installed:");
    io.stdout(line);
  } else {
    const r = await (deps.run ?? runCommand)(claude, args);
    if (r.code !== 0) {
      const out = `${r.stderr}\n${r.stdout}`;
      if (/already exists/i.test(out)) {
        io.stdout(
          `'${MCP_SERVER_NAME}' is already registered (scope ${scope}). To replace it: claude mcp remove --scope ${scope} ${MCP_SERVER_NAME}, then run setup again.`,
        );
      } else {
        io.stderr(`setup: ${line} failed (exit ${r.code ?? "none"})`);
        for (const l of out.trim().split("\n")) if (l.trim() !== "") io.stderr(`  ${l}`);
        return 1;
      }
    } else {
      io.stdout(`registered: ${line}`);
      io.stdout(`check it with: claude mcp list   (${MCP_SERVER_NAME} should show as Connected)`);
    }
  }

  if (!withKey) {
    io.stdout(
      env.ANYBENCH_API_KEY
        ? "ANYBENCH_API_KEY is set in this shell; Claude Code passes it to the server when it starts from here."
        : "Set ANYBENCH_API_KEY (an API key with scope runs:write) in the environment Claude Code runs in for push_kit, start_run and the run tools. The kit-authoring tools need no key.",
    );
  }
  if (skills) io.stdout("--skills: the /anybench skills arrive with 19.5; nothing installed yet.");
  return 0;
}
