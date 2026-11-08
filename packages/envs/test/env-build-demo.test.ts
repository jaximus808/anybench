// demo-env-trials: buildEnvSnapshot on FakeProvider (no network): the image gets recipes, the
// runner, the subject files and the contender installs, is snapshotted, and the build computer is
// destroyed on every path; a failing step is an EnvBuildError naming it.
import { FakeProvider, ProviderCapacityError } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  AGENT_CC_RECIPES,
  BASE_RECIPES,
  buildEnvSnapshot,
  envBuildHash,
  envBuildTag,
  EnvBuildError,
  parseRecipeManifest,
  recipesForProfile,
  runnerFromBytes,
  type Recipe,
  type RecipeCatalog,
} from "../src/index.js";

function demoRecipe(name: string, env: Record<string, string> = {}): Recipe {
  return {
    manifest: parseRecipeManifest({
      name,
      version: "1.2.3",
      description: `demo ${name}`,
      arch: ["x64", "arm64"],
      env,
    }),
    install: `# install ${name}\n`,
    healthcheck: `# healthcheck ${name}\n`,
  };
}

const catalog: RecipeCatalog = {
  recipes: new Map([["tool", demoRecipe("tool", { TOOL_HOME: "/opt/tool" })]]),
  lib: "# lib\n",
};

function demoProvider() {
  const p = new FakeProvider();
  p.onExec("uname -m", () => "x86_64\n");
  // Recipe health check before install fails (so it installs), every other script passes.
  let healthy = false;
  p.onExec(/bash \.\/healthcheck\.sh$/, () => (healthy ? "" : { exitCode: 1 }));
  p.onExec(/bash \.\/install\.sh$/, () => {
    healthy = true;
    return "";
  });
  p.onExec(/runner --version$/, () => "anybench-runner 0.0.0\n");
  return p;
}

describe("env build (demo-env-trials)", () => {
  it("maps profiles to recipes", () => {
    expect(recipesForProfile("base")).toEqual(BASE_RECIPES);
    expect(recipesForProfile("agent-cc")).toEqual(AGENT_CC_RECIPES);
    expect(recipesForProfile("gpu")).toBeNull();
  });

  it("hashes canonically (key order does not matter)", () => {
    expect(envBuildHash({ a: 1, b: [1, 2] })).toBe(envBuildHash({ b: [1, 2], a: 1 }));
    expect(envBuildHash({ a: 1 })).not.toBe(envBuildHash({ a: 2 }));
  });

  it("builds, snapshots and destroys the build computer", async () => {
    const p = demoProvider();
    const installs: string[] = [];
    p.onExec(
      (c) => c.includes("kit/adapters/a/install.sh"),
      (ctx) => {
        installs.push(ctx.command);
        return "";
      },
    );
    p.onExec(
      (c) => c.includes("kit/adapters/a/healthcheck.sh"),
      () => "",
    );
    const snap = await buildEnvSnapshot({
      provider: p,
      spec: { vcpu: 2, memoryMb: 4096, diskGb: 20 },
      label: "abc123",
      recipes: ["tool"],
      catalog,
      runner: runnerFromBytes({ x64: new TextEncoder().encode("RUNNER") }),
      files: [{ path: "kit/adapters/a/install.sh", content: "#!/bin/bash\n", mode: 0o755 }],
      installs: [
        {
          name: "a",
          script: "kit/adapters/a/install.sh",
          healthcheck: "kit/adapters/a/healthcheck.sh",
          env: { V: "1" },
        },
      ],
    });
    expect(snap.snapshotId).toMatch(/.+/);
    expect(snap.arch).toBe("x64");
    expect(snap.recipes.env).toEqual({ TOOL_HOME: "/opt/tool" });
    // Runner and subject files are in the image.
    const home = p.home;
    const all = await p.list({ includeDestroyed: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.tags).toContain(envBuildTag("abc123"));
    expect(envBuildTag("abc123").startsWith("ab-infra-")).toBe(true);
    // Destroyed on success.
    expect((await p.list()).length).toBe(0);
    // A fork of the snapshot has the runner and the kit files.
    const fork = await p.waitReady((await p.fork(snap.snapshotId)).id);
    expect(new TextDecoder().decode(await p.getFile(fork.id, `${home}/.anybench/bin/runner`))).toBe(
      "RUNNER",
    );
    expect(
      new TextDecoder().decode(await p.getFile(fork.id, `${home}/kit/adapters/a/install.sh`)),
    ).toBe("#!/bin/bash\n");
    // The install ran with the recipe env and the contender's versions, as root when not root.
    expect(installs.length).toBeGreaterThan(0);
    expect(installs[0]).toContain("sudo -n env HOME=");
    expect(installs[0]).toContain("TOOL_HOME=");
    expect(installs[0]).toContain("V=");
  });

  it("a failing install is an EnvBuildError at install, and the computer is destroyed", async () => {
    const p = demoProvider();
    p.onExec(
      (c) => c.includes("kit/adapters/a/install.sh"),
      () => ({ exitCode: 7, stderr: "npm ERR! boom" }),
    );
    const err = await buildEnvSnapshot({
      provider: p,
      spec: {},
      label: "fail",
      recipes: ["tool"],
      catalog,
      installs: [{ name: "a", script: "kit/adapters/a/install.sh" }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvBuildError);
    expect((err as EnvBuildError).step).toBe("install");
    expect((err as EnvBuildError).output).toContain("npm ERR! boom");
    expect((await p.list()).length).toBe(0);
  });

  it("retries a create the provider refused for capacity (Naïve 429), then builds", async () => {
    const p = demoProvider();
    p.failNext("create", new ProviderCapacityError("at capacity", { provider: "fake" }));
    p.failNext("create", new ProviderCapacityError("at capacity", { provider: "fake" }));
    const snap = await buildEnvSnapshot({
      provider: p,
      spec: {},
      label: "cap",
      recipes: ["tool"],
      catalog,
      createBackoffMs: 1,
    });
    expect(snap.snapshotId).toMatch(/.+/);
    expect((await p.list()).length).toBe(0);
  });

  it("retries a destroy the provider refused for capacity (Naïve 429), so nothing leaks", async () => {
    const p = demoProvider();
    p.failNext("destroy", new ProviderCapacityError("at capacity", { provider: "fake" }));
    p.failNext("destroy", new ProviderCapacityError("at capacity", { provider: "fake" }));
    const snap = await buildEnvSnapshot({
      provider: p,
      spec: {},
      label: "dcap",
      recipes: ["tool"],
      catalog,
      destroyBackoffMs: 1,
    });
    expect(snap.snapshotId).toMatch(/.+/);
    expect((await p.list()).length).toBe(0);
  });

  it("a failing recipe is an EnvBuildError at recipes", async () => {
    const p = new FakeProvider();
    p.onExec("uname -m", () => "x86_64\n");
    p.onExec(/bash \.\/(install|healthcheck)\.sh$/, () => ({ exitCode: 1, stderr: "nope" }));
    const err = await buildEnvSnapshot({
      provider: p,
      spec: {},
      label: "r",
      recipes: ["tool"],
      catalog,
    }).catch((e: unknown) => e);
    expect((err as EnvBuildError).step).toBe("recipes");
    expect((await p.list()).length).toBe(0);
  });
});
