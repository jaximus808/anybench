// TDM-25 unit tests: recipe contract, dependency order, catalog of base recipes and the
// runner's events and failure handling, on FakeProvider (no Docker, no network).
import { AnybenchEventSchema, type AnybenchEvent } from "@anybench/core";
import { FakeProvider } from "@anybench/providers";
import { describe, expect, it } from "vitest";
import {
  BASE_RECIPES,
  RecipeError,
  RecipeRunError,
  archFromUname,
  loadRecipeCatalog,
  parseRecipeManifest,
  renderRecipeEnv,
  resolveRecipeOrder,
  runRecipes,
  type Recipe,
  type RecipeCatalog,
  type RecipeManifestInput,
} from "../src/index.js";

function tdm25Recipe(m: Partial<RecipeManifestInput> & { name: string }): Recipe {
  return {
    manifest: parseRecipeManifest({
      version: "1.0.0",
      description: `test recipe ${m.name}`,
      arch: ["x64", "arm64"],
      ...m,
    }),
    install: `# install ${m.name}\n`,
    healthcheck: `# healthcheck ${m.name}\n`,
  };
}

function tdm25Catalog(...rs: Recipe[]): RecipeCatalog {
  return { recipes: new Map(rs.map((r) => [r.manifest.name, r])), lib: "# lib\n" };
}

async function tdm25Computer(machine = "aarch64") {
  const p = new FakeProvider();
  const c = await p.waitReady((await p.create({})).id);
  p.onExec("uname -m", () => `${machine}\n`);
  return { p, id: c.id };
}

describe("recipe manifest", () => {
  it("applies defaults and accepts a pinned download per arch", () => {
    const m = parseRecipeManifest({
      name: "tool",
      version: "2.3.0",
      description: "a tool",
      arch: ["x64"],
      downloads: {
        x64: {
          url: "https://example.com/t.tgz",
          sha256: "a".repeat(64),
          checksumSource: "upstream",
        },
      },
    });
    expect(m).toMatchObject({ deps: [], env: {}, path: [], timeouts: {} });
  });

  it.each([
    [{ env: { PATH: "/x" } }, "env.PATH"],
    [{ env: { RECIPE_URL: "x" } }, "env.RECIPE_URL"],
    [{ env: { "bad-name": "x" } }, "env.bad-name"],
    [{ deps: ["tool"] }, "deps"],
    [{ arch: [] }, "arch"],
    [{ arch: ["sparc"] }, "arch.0"],
    [{ version: "1 0" }, "version"],
    [{ path: ["relative/bin"] }, "path.0"],
    [
      {
        arch: ["x64", "arm64"],
        downloads: {
          x64: { url: "https://e.com/a", sha256: "b".repeat(64), checksumSource: "upstream" },
        },
      },
      "downloads.arm64",
    ],
    [
      {
        arch: ["x64"],
        downloads: {
          x64: { url: "http://e.com/a", sha256: "b".repeat(64), checksumSource: "upstream" },
        },
      },
      "downloads.x64.url",
    ],
    [
      {
        arch: ["x64"],
        downloads: { x64: { url: "https://e.com/a", sha256: "XYZ", checksumSource: "upstream" } },
      },
      "downloads.x64.sha256",
    ],
  ])("rejects %j at %s", (patch, path) => {
    const bad = { name: "tool", version: "1.0.0", description: "d", arch: ["x64"], ...patch };
    expect(() => parseRecipeManifest(bad)).toThrow(RecipeError);
    expect(() => parseRecipeManifest(bad)).toThrow(new RegExp(`${path.replace(".", "\\.")}:`));
  });

  it("maps uname -m to recipe arches", () => {
    expect(archFromUname("x86_64\n")).toBe("x64");
    expect(archFromUname("aarch64")).toBe("arm64");
    expect(archFromUname("riscv64")).toBeNull();
  });
});

describe("resolveRecipeOrder", () => {
  const cat = tdm25Catalog(
    tdm25Recipe({ name: "a", deps: ["b", "c"] }),
    tdm25Recipe({ name: "b", deps: ["c"] }),
    tdm25Recipe({ name: "c" }),
    tdm25Recipe({ name: "d" }),
  );
  const names = (rs: Recipe[]) => rs.map((r) => r.manifest.name);

  it("puts deps first, keeps request order, lists each once", () => {
    expect(names(resolveRecipeOrder(cat, ["d", "a"]))).toEqual(["d", "c", "b", "a"]);
    expect(names(resolveRecipeOrder(cat, ["c", "a", "c"]))).toEqual(["c", "b", "a"]);
  });

  it("rejects unknown recipes and cycles", () => {
    expect(() => resolveRecipeOrder(cat, ["zzz"])).toThrow("unknown recipe 'zzz'");
    const bad = tdm25Catalog(tdm25Recipe({ name: "a", deps: ["nope"] }));
    expect(() => resolveRecipeOrder(bad, ["a"])).toThrow("'a' depends on unknown recipe 'nope'");
    const cyc = tdm25Catalog(
      tdm25Recipe({ name: "x", deps: ["y"] }),
      tdm25Recipe({ name: "y", deps: ["z"] }),
      tdm25Recipe({ name: "z", deps: ["x"] }),
    );
    expect(() => resolveRecipeOrder(cyc, ["x"])).toThrow("cycle: x -> y -> z -> x");
  });
});

describe("base recipe catalog", () => {
  it("loads all six base recipes, each pinned, on x64 and arm64", async () => {
    const cat = await loadRecipeCatalog();
    expect([...cat.recipes.keys()].sort()).toEqual([...BASE_RECIPES].sort());
    expect(cat.lib).toContain("fetch_verified()");
    for (const r of cat.recipes.values()) {
      expect(r.manifest.arch.sort()).toEqual(["arm64", "x64"]);
      expect(r.manifest.version).not.toMatch(/latest/i);
      expect(r.install).toMatch(/^#!\/usr\/bin\/env bash\n/);
      expect(r.install).toContain("set -euo pipefail");
      expect(r.healthcheck).toContain("set -euo pipefail");
      // a recipe that downloads must go through the sha256-checking fetch
      if (Object.keys(r.manifest.downloads).length > 0) {
        expect(r.install).toContain('fetch_verified "$RECIPE_URL" "$RECIPE_SHA256"');
      }
    }
  });
});

describe("runRecipes on FakeProvider", () => {
  const cat = tdm25Catalog(
    tdm25Recipe({ name: "base", env: { BASE_HOME: "/opt/base" }, path: ["/opt/base/bin"] }),
    tdm25Recipe({
      name: "tool",
      version: "2.0.0",
      deps: ["base"],
      env: { TOOL_URL: "x://it's" },
      downloads: {
        x64: { url: "https://e.com/x", sha256: "1".repeat(64), checksumSource: "upstream" },
        arm64: { url: "https://e.com/a", sha256: "2".repeat(64), checksumSource: "upstream" },
      },
    }),
  );

  it("installs in dependency order, emits valid events, and returns the env", async () => {
    const { p, id } = await tdm25Computer("aarch64");
    const installed = new Set<string>();
    p.onExec(/RECIPE_NAME='(\w+)'.* bash \.\/(install|healthcheck)\.sh$/, ({ match }) => {
      const [, name, step] = match!;
      if (step === "install") {
        installed.add(name!);
        return "";
      }
      return { exitCode: installed.has(name!) ? 0 : 1 };
    });
    const events: AnybenchEvent[] = [];
    const res = await runRecipes(p, id, ["tool"], {
      catalog: cat,
      runId: "run_1",
      seqStart: 10,
      onEvent: (e) => void events.push(e),
    });

    expect(res.arch).toBe("arm64");
    expect(res.results.map((r) => [r.name, r.status])).toEqual([
      ["base", "installed"],
      ["tool", "installed"],
    ]);
    expect(res.env).toEqual({ BASE_HOME: "/opt/base", TOOL_URL: "x://it's" });
    expect(res.path).toEqual(["/opt/base/bin"]);
    expect(renderRecipeEnv(res)).toBe(
      "export BASE_HOME='/opt/base'\nexport TOOL_URL='x://it'\\''s'\nexport PATH='/opt/base/bin':\"$PATH\"\n",
    );

    for (const e of events) expect(AnybenchEventSchema.parse(e)).toEqual(e);
    expect(events.map((e) => e.seq)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(
      events.map((e) =>
        e.type === "computer.recipe" ? `${e.payload.recipe}:${e.payload.phase}` : "",
      ),
    ).toEqual([
      "base:started",
      "base:installed",
      "base:healthy",
      "tool:started",
      "tool:installed",
      "tool:healthy",
    ]);
    expect(events[0]).toMatchObject({ run_id: "run_1", source: "computer", source_id: id });

    // the dependent's scripts see the dep's env and PATH, and the arm64 pin
    const toolInstall = p
      .commands()
      .find((c) => /RECIPE_NAME='tool'.*install\.sh$/.test(c.command));
    expect(toolInstall?.command).toContain(`PATH='/opt/base/bin':"$PATH"`);
    expect(toolInstall?.command).toContain("BASE_HOME='/opt/base'");
    expect(toolInstall?.command).toContain("RECIPE_URL='https://e.com/a'");
    expect(toolInstall?.command).toContain(`RECIPE_SHA256='${"2".repeat(64)}'`);
    // scripts and the lib were written under home
    const home = (await p.inspect(id)).home;
    const text = new TextDecoder();
    expect(
      text.decode(await p.getFile(id, `${home}/.anybench/recipes/tool@2.0.0/install.sh`)),
    ).toBe("# install tool\n");
    expect(text.decode(await p.getFile(id, `${home}/.anybench/recipes/_lib.sh`))).toBe("# lib\n");
  });

  it("skips a recipe whose health check already passes, unless reinstall", async () => {
    const { p, id } = await tdm25Computer("x86_64");
    p.onExec(/bash \.\/healthcheck\.sh$/, () => "ok");
    p.onExec(/bash \.\/install\.sh$/, () => "");
    const events: AnybenchEvent[] = [];
    const res = await runRecipes(p, id, ["tool"], {
      catalog: cat,
      onEvent: (e) => void events.push(e),
    });
    expect(res.results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(res.env.TOOL_URL).toBe("x://it's");
    expect(events.map((e) => e.type === "computer.recipe" && e.payload.phase)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(p.commands().some((c) => c.command.endsWith("install.sh"))).toBe(false);

    const again = await runRecipes(p, id, ["base"], { catalog: cat, reinstall: true });
    expect(again.results.map((r) => r.status)).toEqual(["installed"]);
  });

  it("stops at the first failing step with a failed event and RecipeRunError", async () => {
    const { p, id } = await tdm25Computer("x86_64");
    p.onExec(/RECIPE_NAME='base'.*install\.sh$/, () => "");
    p.onExec(/RECIPE_NAME='base'.*healthcheck\.sh$/, () => ({
      stderr: "[base] error: sha256 mismatch",
      exitCode: 1,
    }));
    const events: AnybenchEvent[] = [];
    const err = await runRecipes(p, id, ["tool"], {
      catalog: cat,
      reinstall: true,
      onEvent: (e) => void events.push(e),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    const re = err as RecipeRunError;
    expect(re.recipe).toBe("base");
    expect(re.message).toContain("health check exited 1");
    expect(re.results).toEqual([
      expect.objectContaining({
        name: "base",
        status: "failed",
        failedStep: "healthcheck",
        exitCode: 1,
      }),
    ]);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ severity: "error", type: "computer.recipe" });
    expect(last.type === "computer.recipe" && last.payload).toMatchObject({
      recipe: "base",
      phase: "failed",
      step: "healthcheck",
      exit_code: 1,
    });
    expect(last.type === "computer.recipe" && last.payload.error).toContain("sha256 mismatch");
    // the dependent never ran
    expect(p.commands().some((c) => c.command.includes("RECIPE_NAME='tool'"))).toBe(false);
  });

  it("fails a recipe that does not support the machine's arch", async () => {
    const { p, id } = await tdm25Computer("x86_64");
    const armOnly = tdm25Catalog(tdm25Recipe({ name: "armonly", arch: ["arm64"] }));
    await expect(runRecipes(p, id, ["armonly"], { catalog: armOnly })).rejects.toThrow(
      "does not support x64",
    );
  });

  it("rejects an unsupported machine before running anything", async () => {
    const { p, id } = await tdm25Computer("riscv64");
    await expect(runRecipes(p, id, ["base"], { catalog: cat })).rejects.toThrow(
      "unsupported machine 'riscv64'",
    );
  });
});
