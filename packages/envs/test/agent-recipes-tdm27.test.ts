// TDM-27 unit tests: the agent recipes (eval-user, claude-code, tandem, playwright) load, are
// pinned to exact versions that agree across recipe.json and the scripts, resolve in the right
// order for the agent-cc profile, and their scripts parse. No Docker, no network.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { FakeProvider } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  AGENT_CC_RECIPES,
  AGENT_RECIPES,
  BASE_RECIPES,
  BASE_RECIPES_DIR,
  RECIPE_LIB_FILE,
  loadRecipeCatalog,
  resolveRecipeOrder,
  runRecipes,
  type Recipe,
} from "../src/index.js";

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

async function tdm27Agent(name: (typeof AGENT_RECIPES)[number]): Promise<Recipe> {
  const r = (await loadRecipeCatalog()).recipes.get(name);
  expect(r, `recipe ${name}`).toBeDefined();
  return r!;
}

describe("agent recipe catalog", () => {
  it("ships every agent recipe next to the base ones, for x64 and arm64", async () => {
    const cat = await loadRecipeCatalog();
    expect([...cat.recipes.keys()].sort()).toEqual([...BASE_RECIPES, ...AGENT_RECIPES].sort());
    for (const n of AGENT_RECIPES) {
      const r = cat.recipes.get(n)!;
      expect(r.manifest.arch.sort()).toEqual(["arm64", "x64"]);
      expect(r.install).toMatch(/^#!\/usr\/bin\/env bash\n/);
      expect(r.install).toContain("set -euo pipefail");
      expect(r.healthcheck).toContain("set -euo pipefail");
    }
  });

  it("never installs a floating version", async () => {
    for (const n of AGENT_RECIPES) {
      const r = await tdm27Agent(n);
      const all = [JSON.stringify(r.manifest), r.install, r.healthcheck].join("\n");
      expect(all, n).not.toMatch(/latest/i);
      // every npm spec in a script is name@$PINNED_VAR, never a bare name or a range
      for (const m of all.matchAll(
        /"(@?[a-z0-9@/._-]*(?:claude-code|tandem-mcp|playwright))@([^"]*)"/g,
      )) {
        expect(m[2], `${n}: ${m[0]}`).toMatch(/^\$[A-Z_]+_VERSION$/);
      }
    }
  });

  it("claude-code pins one exact version everywhere", async () => {
    const { manifest: m, install } = await tdm27Agent("claude-code");
    expect(m.version).toMatch(EXACT_SEMVER);
    expect(m.env.CLAUDE_CODE_VERSION).toBe(m.version);
    expect(m.env.ANYBENCH_CLAUDE_CODE_HOME).toBe(`/opt/anybench/claude-code-${m.version}`);
    expect(m.env.DISABLE_AUTOUPDATER).toBe("1");
    // the non-secret Naïve proxy switches from TDM-16 (verified live on 2.1.319)
    expect(m.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.vetta.sh/v1/proxy/anthropic",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_MODEL_CAPABILITIES:
        "-effort,-max_effort,-xhigh_effort,-per_turn_effort,-adaptive_thinking,-context_management,-rejects_disabled_thinking",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    // no secret is ever part of a recipe
    expect(
      Object.keys(m.env).filter((k) => /TOKEN|KEY|SECRET/.test(k) && k !== "MAX_THINKING_TOKENS"),
    ).toEqual([]);
    expect(m.deps).toEqual(["node22", "eval-user"]);
    expect(install).toContain('"@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"');
  });

  it("tandem pins the server binary by sha256 and the paired gateway, autostart off", async () => {
    const { manifest: m, install, healthcheck } = await tdm27Agent("tandem");
    const server = m.env.TANDEM_VERSION!;
    const gateway = m.env.TANDEM_MCP_VERSION!;
    expect(server).toMatch(EXACT_SEMVER);
    expect(gateway).toMatch(EXACT_SEMVER);
    expect(m.version).toBe(`${server}-mcp${gateway}`);
    expect(m.env).toMatchObject({
      TANDEM_AUTOSTART: "0",
      TANDEM_BIN: "/usr/local/bin/tandem",
      ANYBENCH_TANDEM_HOME: `/opt/anybench/tandem-${server}`,
      ANYBENCH_TANDEM_MCP_HOME: `/opt/anybench/tandem-mcp-${gateway}`,
    });
    expect(m.deps).toEqual(["node22", "eval-user", "claude-code"]);
    const goarch = { x64: "amd64", arm64: "arm64" } as const;
    for (const a of ["x64", "arm64"] as const) {
      const d = m.downloads[a]!;
      expect(d.url).toBe(
        `https://github.com/jaximus808/tandem/releases/download/v${server}/tandem_linux_${goarch[a]}`,
      );
      expect(d.checksumSource).toBe("upstream");
    }
    expect(install).toContain('fetch_verified "$RECIPE_URL" "$RECIPE_SHA256"');
    expect(install).toContain('npx -y "@jaximus/tandem-mcp@$TANDEM_MCP_VERSION"');
    // the health check proves the cache is warm (offline) and the server answers /healthz
    expect(healthcheck).toContain("npx --offline -y");
    expect(healthcheck).toContain("up --foreground");
    expect(healthcheck).toContain("/healthz");
  });

  it("playwright pins npm and launches as the eval user", async () => {
    const { manifest: m, healthcheck } = await tdm27Agent("playwright");
    expect(m.env.PLAYWRIGHT_VERSION).toMatch(EXACT_SEMVER);
    expect(m.version).toBe(`${m.env.PLAYWRIGHT_VERSION}-chromium`);
    expect(m.env.PLAYWRIGHT_BROWSERS_PATH).toMatch(/^\/opt\/anybench\//);
    expect(healthcheck).toContain('as_user "$EVAL_USER"');
    expect(healthcheck).toContain("about:blank");
  });

  it("the eval user is created without sudo and checked for it", async () => {
    const { manifest: m, install, healthcheck } = await tdm27Agent("eval-user");
    expect(m.env).toEqual({ ANYBENCH_EVAL_USER: "eval", ANYBENCH_EVAL_HOME: "/home/eval" });
    expect(install).not.toMatch(/sudoers|usermod|-G\s*sudo/);
    expect(healthcheck).toContain("has passwordless sudo");
  });

  it("resolves the agent-cc profile with deps first", async () => {
    const cat = await loadRecipeCatalog();
    const order = resolveRecipeOrder(cat, [...AGENT_CC_RECIPES]).map((r) => r.manifest.name);
    expect(order).toEqual([...BASE_RECIPES, "eval-user", "claude-code", "tandem"]);
    expect(resolveRecipeOrder(cat, ["tandem"]).map((r) => r.manifest.name)).toEqual([
      "node22",
      "eval-user",
      "claude-code",
      "tandem",
    ]);
  });

  it.skipIf(spawnSync("bash", ["--version"]).status !== 0)(
    "every agent script and the shared lib parse with bash -n",
    () => {
      const files = [
        join(BASE_RECIPES_DIR, RECIPE_LIB_FILE),
        ...AGENT_RECIPES.flatMap((n) =>
          ["install.sh", "healthcheck.sh"].map((f) => join(BASE_RECIPES_DIR, n, f)),
        ),
      ];
      for (const f of files) {
        const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
        expect(r.stderr, f).toBe("");
        expect(r.status, f).toBe(0);
      }
    },
  );
});

describe("agent recipes on FakeProvider", () => {
  it("hands each script the merged env of its deps (TANDEM_* reaches tandem, NODE_HOME reaches all)", async () => {
    const p = new FakeProvider();
    const id = (await p.waitReady((await p.create({})).id)).id;
    p.onExec("uname -m", () => "x86_64\n");
    const installed = new Set<string>();
    p.onExec(/RECIPE_NAME='([\w-]+)'.* bash \.\/(install|healthcheck)\.sh$/, ({ match }) => {
      const [, name, step] = match!;
      if (step === "install") {
        installed.add(name!);
        return "";
      }
      return { exitCode: installed.has(name!) ? 0 : 1 };
    });
    const res = await runRecipes(p, id, ["tandem"]);
    expect(res.results.map((r) => [r.name, r.status])).toEqual([
      ["node22", "installed"],
      ["eval-user", "installed"],
      ["claude-code", "installed"],
      ["tandem", "installed"],
    ]);
    expect(res.env).toMatchObject({
      ANYBENCH_EVAL_USER: "eval",
      CLAUDE_CODE_VERSION: expect.stringMatching(EXACT_SEMVER),
      TANDEM_AUTOSTART: "0",
      DISABLE_AUTOUPDATER: "1",
    });
    const tandemInstall = p
      .commands()
      .find((c) => /RECIPE_NAME='tandem'.*install\.sh$/.test(c.command))!.command;
    expect(tandemInstall).toContain("NODE_HOME='/opt/anybench/node-v");
    expect(tandemInstall).toContain("ANYBENCH_EVAL_USER='eval'");
    expect(tandemInstall).toContain("RECIPE_URL='https://github.com/jaximus808/tandem/");
    expect(tandemInstall).toContain("tandem_linux_amd64'");
  });
});
