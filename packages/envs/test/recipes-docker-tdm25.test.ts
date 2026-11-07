// TDM-25 done condition: all six base recipes install and pass their health checks on
// docker-local (ubuntu:24.04, the host's arch), in one shared container for speed. A second
// run on the same container must skip every recipe (health check first), and the tools must
// work for the unprivileged `naive` user too. Skips cleanly when no Docker daemon answers.
//
// Set ANYBENCH_RECIPES_LOG=<file> to append the per-recipe timings as JSON (used for
// docs/findings/recipes.md).
import { appendFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { AnybenchEvent } from "@anybench/core";
import { DockerLocalProvider, dockerLocalAvailable, trialTag } from "@anybench/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_RECIPES, renderRecipeEnv, runRecipes, type RecipeRunResult } from "../src/index.js";

const available = await dockerLocalAvailable();
const NS_LABEL = "anybench.test-tdm25";
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!available)("base recipes on docker-local", () => {
  const p = new DockerLocalProvider({ labels: { [NS_LABEL]: ns } });
  let id = "";
  let first: RecipeRunResult | undefined;
  const events: AnybenchEvent[] = [];

  beforeAll(async () => {
    const c = await p.create({ vcpu: 2, memoryMb: 2048, tags: [trialTag(ns, "recipes")] });
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

  it("installs all six in dependency order and every health check passes", async () => {
    first = await runRecipes(p, id, [...BASE_RECIPES], {
      runId: `run_${ns}`,
      onEvent: (e) => void events.push(e),
    });
    const log = process.env.ANYBENCH_RECIPES_LOG;
    if (log) {
      const uname = await p.exec(id, "uname -m; . /etc/os-release; echo $PRETTY_NAME");
      await appendFile(
        log,
        `${JSON.stringify({ at: new Date().toISOString(), uname: uname.stdout.trim().split("\n"), arch: first.arch, results: first.results, env: first.env })}\n`,
      );
    }
    expect(first.results.map((r) => [r.name, r.status])).toEqual(
      BASE_RECIPES.map((n) => [n, "installed"]),
    );
    const phases = events.map((e) =>
      e.type === "computer.recipe" ? `${e.payload.recipe}:${e.payload.phase}` : e.type,
    );
    expect(phases).toEqual(
      BASE_RECIPES.flatMap((n) => [`${n}:started`, `${n}:installed`, `${n}:healthy`]),
    );
    expect(first.env).toMatchObject({
      NODE_HOME: "/opt/anybench/node-v22.23.4",
      UV_PYTHON: "3.12.15",
      K6_NO_USAGE_REPORT: "true",
      ANYBENCH_GNU_TIME: "/usr/bin/time",
    });
  }, 1_800_000);

  it("a second run skips every recipe because its health check already passes", async () => {
    expect(first, "first run must have passed").toBeDefined();
    const again = await runRecipes(p, id, [...BASE_RECIPES]);
    expect(again.results.map((r) => r.status)).toEqual(BASE_RECIPES.map(() => "skipped"));
    expect(again.env).toEqual(first!.env);
  }, 600_000);

  it("the tools work for the unprivileged naive user with the exported env", async () => {
    expect(first, "first run must have passed").toBeDefined();
    await p.putFile(id, ".anybench/recipes.env", renderRecipeEnv(first!), { mode: 0o644 });
    const r = await p.exec(
      id,
      [
        "runuser -u naive -- bash -c '",
        "set -euo pipefail; . ~/.anybench/recipes.env;",
        "node --version; python3 --version; uv --version; git --version;",
        "hyperfine --version; k6 version | head -1; command -v hey;",
        'd=$(mktemp -d); uv venv --quiet --offline --cache-dir $d/c $d/v && $d/v/bin/python -c "print(42)"',
        "'",
      ].join(" "),
      { timeoutMs: 120_000 },
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("v22.23.4");
    expect(r.stdout).toContain("Python 3.12.15");
    expect(r.stdout).toContain("uv 0.13.4");
    expect(r.stdout).toContain("git version 2.43.0");
    expect(r.stdout).toContain("hyperfine 1.21.0");
    expect(r.stdout).toContain("v2.3.0");
    expect(r.stdout).toContain("/usr/bin/hey");
    expect(r.stdout.trimEnd().endsWith("42")).toBe(true);
  }, 180_000);
});
