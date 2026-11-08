// TDM-27 done condition on docker-local (ubuntu:24.04, the host's arch): claude-code, tandem and
// playwright (with their deps node22 and eval-user) install and pass their health checks, which
// run `claude --version` as the eval user, start `tandem-mcp up --foreground` as the eval user
// and read GET /healthz, and open about:blank in headless Chromium as the eval user. A second
// run skips all of them.
//
// Opt-in, because it downloads ~400 MB and runs Chromium:
//   ANYBENCH_AGENT_RECIPES_DOCKER=1 pnpm --filter @anybench/envs exec vitest run recipes-docker-tdm27
// Set ANYBENCH_RECIPES_LOG=<file> to append the per-recipe timings as JSON.
import { appendFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { DockerLocalProvider, dockerLocalAvailable, trialTag } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderRecipeEnv, runRecipes, type RecipeRunResult } from "../src/index.js";

const enabled = process.env.ANYBENCH_AGENT_RECIPES_DOCKER === "1" && (await dockerLocalAvailable());
const NS_LABEL = "anybench.test-tdm27";
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const REQUESTED = ["claude-code", "tandem", "playwright"];
const ORDER = ["node22", "eval-user", "claude-code", "tandem", "playwright"];

describe.skipIf(!enabled)("agent recipes on docker-local", () => {
  const p = new DockerLocalProvider({ labels: { [NS_LABEL]: ns } });
  let id = "";
  let first: RecipeRunResult | undefined;

  beforeAll(async () => {
    const c = await p.create({ vcpu: 2, memoryMb: 4096, tags: [trialTag(ns, "agent-recipes")] });
    id = (await p.waitReady(c.id, { timeoutMs: 600_000, intervalMs: 500 })).id;
  }, 660_000);

  afterAll(async () => {
    if (id) await p.destroy(id);
    await p.dispose();
    const left = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=${NS_LABEL}=${ns}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (left) spawnSync("docker", ["rm", "-f", "-v", ...left.split("\n")]);
    expect(left, "the suite leaked containers").toBe("");
  }, 120_000);

  it("installs claude-code, tandem and playwright and every health check passes", async () => {
    first = await runRecipes(p, id, REQUESTED, { runId: `run_${ns}` });
    const log = process.env.ANYBENCH_RECIPES_LOG;
    if (log) {
      const uname = await p.exec(id, "uname -m; . /etc/os-release; echo $PRETTY_NAME");
      await appendFile(
        log,
        `${JSON.stringify({ at: new Date().toISOString(), uname: uname.stdout.trim().split("\n"), arch: first.arch, results: first.results, env: first.env })}\n`,
      );
    }
    expect(first.results.map((r) => [r.name, r.status])).toEqual(
      ORDER.map((n) => [n, "installed"]),
    );
    expect(first.env).toMatchObject({ TANDEM_AUTOSTART: "0", ANYBENCH_EVAL_USER: "eval" });
  }, 1_800_000);

  it("a second run skips every recipe", async () => {
    expect(first, "first run must have passed").toBeDefined();
    const again = await runRecipes(p, id, REQUESTED);
    expect(again.results.map((r) => r.status)).toEqual(ORDER.map(() => "skipped"));
    expect(again.env).toEqual(first!.env);
  }, 600_000);

  it("the eval user, with the exported env, runs claude and the tandem binary", async () => {
    expect(first, "first run must have passed").toBeDefined();
    await p.putFile(id, ".anybench/recipes.env", renderRecipeEnv(first!), { mode: 0o644 });
    const r = await p.exec(
      id,
      [
        "cp /home/naive/.anybench/recipes.env /tmp/recipes.env && chmod 644 /tmp/recipes.env &&",
        "runuser -u eval -- env -i HOME=/home/eval PATH=/usr/local/bin:/usr/bin:/bin bash -c '",
        "set -euo pipefail; cd; . /tmp/recipes.env; id -un; claude --version;",
        'test "$TANDEM_AUTOSTART" = 0; sha256sum "$(readlink -f "$(command -v tandem)")";',
        "tandem-mcp --version'",
      ].join(" "),
      { timeoutMs: 120_000 },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const [user, claude, sha, mcp] = r.stdout.trim().split("\n");
    expect(user).toBe("eval");
    expect(claude).toBe(`${first!.env.CLAUDE_CODE_VERSION} (Claude Code)`);
    expect(sha).toMatch(/^[0-9a-f]{64} {2}\/opt\/anybench\/tandem-0\.2\.0\/tandem$/);
    expect(mcp).toContain(first!.env.TANDEM_MCP_VERSION);
  }, 180_000);
});
