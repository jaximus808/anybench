// TDM-56 [6.2]: the understander role folder, its input and the verdict rules enforced in code.
// No network, no spend.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProjectDigest } from "@anybench/core";
import { RepoIngestSchema, type RepoContext, type RepoIngest } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  buildUnderstanderInput,
  decideUnderstanding,
  hasExecutableEvidence,
  loadRole,
  nothingRunnable,
  numberedReadme,
  roleAgentSpec,
  UNDERSTANDER_ROLE,
  UnderstanderOutputSchema,
  UnderstandingExtrasShape,
  verifyClaims,
  type UnderstanderOutput,
} from "../src/index.js";

function fixtureTdm56(name: string): RepoIngest {
  const file = fileURLToPath(new URL(`../../kit/fixtures/digests/${name}.json`, import.meta.url));
  return RepoIngestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const HYPERFINE = fixtureTdm56("hyperfine");
const TANDEM = fixtureTdm56("agentcanvas");

/** A Python library: importable package, no console script, no main. */
function libIngestTdm56(): { digest: ProjectDigest; context: RepoContext } {
  const digest: ProjectDigest = {
    ...HYPERFINE.digest,
    name: "fastmath",
    summary: "Fast numeric helpers",
    languages: [{ name: "Python", bytes: 40_000 }],
    entrypoints: [{ kind: "library", name: "fastmath" }],
    build_commands: ["pip install -e ."],
    test_commands: ["pytest"],
    suggested_driver_types: ["lib"],
  };
  const context: RepoContext = {
    ...HYPERFINE.context,
    tree: {
      paths: [
        "README.md",
        "pyproject.toml",
        "fastmath/__init__.py",
        "fastmath/core.py",
        "tests/test_core.py",
      ],
      dirs: [{ path: "fastmath", files: 2, bytes: 30_000 }],
      truncated: false,
    },
    readme: {
      path: "README.md",
      text: "# fastmath\n\n```python\nimport fastmath\n```\n\nfastmath is 3x faster than numpy for small arrays.\n",
      truncated: false,
    },
    manifests: [
      {
        path: "pyproject.toml",
        kind: "pyproject.toml",
        text: '[project]\nname = "fastmath"\nversion = "0.3.0"\n',
        truncated: false,
      },
    ],
    recent_test_commits: [],
  };
  return { digest, context };
}

/** Docs only: markdown, no manifest, no entrypoint, no commands. */
function docsIngestTdm56(): { digest: ProjectDigest; context: RepoContext } {
  const digest: ProjectDigest = {
    ...HYPERFINE.digest,
    name: "awesome-things",
    summary: "A curated list of things",
    languages: [{ name: "Markdown", bytes: 12_000 }],
    entrypoints: [],
    build_commands: [],
    test_commands: [],
    suggested_driver_types: [],
  };
  const context: RepoContext = {
    ...HYPERFINE.context,
    tree: { paths: ["README.md", "CONTRIBUTING.md"], dirs: [], truncated: false },
    readme: {
      path: "README.md",
      text: "# Awesome things\n\n- [a](https://a.example)\n",
      truncated: false,
    },
    manifests: [],
    tests: { files: 0, dirs: [], sample: [] },
    benchmarks: { files: 0, dirs: [], sample: [] },
    recent_test_commits: [],
  };
  return { digest, context };
}

function outputTdm56(over: Partial<UnderstanderOutput> = {}): UnderstanderOutput {
  return UnderstanderOutputSchema.parse({
    kind: "software",
    driver_type: "cli",
    driver_reason: "ships the hyperfine binary",
    summary: "A command-line benchmarking tool.",
    better_means: ["lower warm wall time on the same output"],
    risks: [],
    benchable: "ready",
    reason: "a Rust CLI that runs on Linux",
    claims: [],
    subject_command: {
      binary: "hyperfine",
      install_route: "github_release",
      package: "hyperfine",
      version_command: "hyperfine --version",
    },
    history: null,
    labelled_conversations: null,
    ...over,
  });
}

describe("understander role (TDM-56)", () => {
  it("loads from packages/agents/understander with a cheap pinned model and a $0.10 task cap", () => {
    const role = loadRole(UNDERSTANDER_ROLE);
    expect(role.config.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(role.config.budget.max_task_micro_usd).toBe(100_000n);
    expect(role.outputSchema).not.toBeNull();
    const spec = roleAgentSpec(UNDERSTANDER_ROLE);
    expect(spec.tools).toMatchObject({ default_config: { permission: "deny" } });
    expect(role.prompt).toContain("not `cli`");
  });

  it("output.schema.json and UnderstanderOutputSchema name the same fields", () => {
    const json = loadRole(UNDERSTANDER_ROLE).outputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const zodKeys = Object.keys(UnderstanderOutputSchema.shape).sort();
    expect(Object.keys(json.properties).sort()).toEqual(zodKeys);
    expect([...json.required].sort()).toEqual(zodKeys);
    // The driver enum is core's DriverTypeSchema.
    const driver = json.properties.driver_type as { enum: string[] };
    expect(driver.enum.sort()).toEqual(
      [...UnderstanderOutputSchema.shape.driver_type.options].sort(),
    );
  });

  it("the input carries a numbered README, the tree, manifests and the test-commit count, bounded", () => {
    for (const fx of [HYPERFINE, TANDEM]) {
      const input = buildUnderstanderInput(fx);
      const text = JSON.stringify(input);
      expect(text.length).toBeLessThan(60_000);
      const readme = input.readme as { path: string; lines: string };
      expect(readme.lines.startsWith("1| ")).toBe(true);
      expect((input.history as { test_commits: number }).test_commits).toBe(
        fx.context.recent_test_commits.length,
      );
      expect((input.digest as Record<string, unknown>).hash).toBeUndefined();
      expect((input.manifests as unknown[]).length).toBeGreaterThan(0);
    }
    const bare = buildUnderstanderInput({ digest: HYPERFINE.digest, context: null });
    expect(bare.note).toMatch(/digest alone/);
    expect(numberedReadme("a\nb\nc", 10)).toEqual({ text: "1| a\n2| b", truncated: true });
  });

  it("a CLI with a binary and release tags is ready / cli / supported", () => {
    expect(hasExecutableEvidence(HYPERFINE)).toBe(true);
    const v = decideUnderstanding(outputTdm56(), HYPERFINE);
    expect(v.outcome).toBe("ready");
    expect(v.understanding).toMatchObject({
      kind: "software",
      driver_type: "cli",
      supported: true,
      benchable: "ready",
      subject_command: { binary: "hyperfine", install_route: "github_release" },
    });
    expect(v.understanding.history).toBeUndefined();
    expect(v.corrections).toEqual([]);
  });

  it("a library is held as not supported; a 'cli' with no executable is corrected to lib", () => {
    const lib = libIngestTdm56();
    expect(hasExecutableEvidence(lib)).toBe(false);
    const said = decideUnderstanding(
      outputTdm56({ driver_type: "lib", driver_reason: "imported as `fastmath`, no binary" }),
      lib,
    );
    expect(said.outcome).toBe("hold");
    expect(said.reason).toBe("driver lib is not supported yet: imported as `fastmath`, no binary");
    expect(said.understanding.supported).toBe(false);
    expect(said.understanding.subject_command).toBeUndefined();

    const miss = decideUnderstanding(outputTdm56(), lib);
    expect(miss.outcome).toBe("hold");
    expect(miss.understanding.driver_type).toBe("lib");
    expect(miss.reason).toMatch(/^driver lib is not supported yet: no executable entrypoint/);
    expect(miss.corrections[0]).toMatch(/^driver cli → lib/);
  });

  it("service, pty, web and x11 hold with 'driver <type> is not supported yet'", () => {
    for (const driver of ["service", "pty", "web", "x11"] as const) {
      const v = decideUnderstanding(
        outputTdm56({ driver_type: driver, driver_reason: "" }),
        HYPERFINE,
      );
      expect(v.outcome).toBe("hold");
      expect(v.reason).toMatch(new RegExp(`^driver ${driver} is not supported yet: .+`));
    }
  });

  it("docs-only fails: by the model's skip, and in code when nothing is runnable", () => {
    const docs = docsIngestTdm56();
    expect(nothingRunnable(docs)).toBe(true);
    const skip = decideUnderstanding(
      outputTdm56({ benchable: "skip", reason: "a list of links", driver_type: "web" }),
      docs,
    );
    expect(skip).toMatchObject({ outcome: "fail", reason: "not benchable: a list of links" });
    // The model says ready: code still fails it.
    const ready = decideUnderstanding(outputTdm56({ driver_type: "cli" }), docs);
    expect(ready.outcome).toBe("fail");
    expect(ready.reason).toMatch(/^not benchable: nothing runnable/);
    expect(nothingRunnable(HYPERFINE)).toBe(false);
  });

  it("needs_hardware holds before the driver check", () => {
    const v = decideUnderstanding(
      outputTdm56({ benchable: "needs_hardware", reason: "needs a webcam", driver_type: "lib" }),
      libIngestTdm56(),
    );
    expect(v).toMatchObject({ outcome: "hold", reason: "needs hardware: needs a webcam" });
  });

  it("http-agent is supported only with a labelled conversation set that is in the tree", () => {
    const withSet: RepoIngest = {
      ...HYPERFINE,
      context: {
        ...HYPERFINE.context,
        tree: {
          ...HYPERFINE.context.tree,
          paths: [...HYPERFINE.context.tree.paths, "evals/labelled.jsonl"],
        },
      },
    };
    const base = {
      driver_type: "http-agent" as const,
      kind: "software" as const,
      subject_command: null,
    };
    const none = decideUnderstanding(outputTdm56({ ...base, driver_reason: "" }), withSet);
    expect(none.outcome).toBe("hold");
    expect(none.reason).toMatch(/^driver http-agent is not supported yet: .*labelled/);
    expect(none.understanding.kind).toBe("agent");

    // A model that spells null as a string is not "inventing" a set (live obrist answer).
    const nullString = decideUnderstanding(
      outputTdm56({ ...base, labelled_conversations: "null" }),
      withSet,
    );
    expect(nullString.corrections.some((c) => c.includes("labelled"))).toBe(false);
    const invented = decideUnderstanding(
      outputTdm56({ ...base, labelled_conversations: "data/qa.json" }),
      withSet,
    );
    expect(invented.outcome).toBe("hold");
    expect(invented.understanding.labelled_conversations).toBeUndefined();

    const real = decideUnderstanding(
      outputTdm56({ ...base, labelled_conversations: "./evals/labelled.jsonl" }),
      withSet,
    );
    expect(real.outcome).toBe("ready");
    expect(real.understanding).toMatchObject({
      supported: true,
      labelled_conversations: "evals/labelled.jsonl",
    });
  });

  it("a harness gets the history signal from the counted test commits; kind follows the driver", () => {
    const v = decideUnderstanding(
      outputTdm56({
        kind: "software",
        driver_type: "harness",
        subject_command: null,
        history: { minable: true, why: "fix commits add tests" },
      }),
      TANDEM,
    );
    expect(v.outcome).toBe("ready");
    expect(v.understanding.kind).toBe("harness");
    expect(v.understanding.history).toMatchObject({
      minable: TANDEM.context.recent_test_commits.length >= 3,
      test_commits: TANDEM.context.recent_test_commits.length,
    });
    const few = decideUnderstanding(
      outputTdm56({ driver_type: "coding-agent", history: { minable: true, why: "" } }),
      libIngestTdm56(),
    );
    expect(few.understanding.history).toMatchObject({ minable: false, test_commits: 0 });
  });

  it("claims are kept only when the quote is on the cited line", () => {
    const lines = HYPERFINE.context.readme!.text.split("\n");
    const n = lines.findIndex((l) => l.includes("9.8x faster")) + 1;
    expect(n).toBeGreaterThan(0);
    const { claims, dropped } = verifyClaims(
      [
        { text: "fd is 9.8x faster than find", quote: "(9.8x faster)", source: `README.md#L${n}` },
        { text: "wrong line", quote: "(9.8x faster)", source: "README.md#L1" },
        { text: "invented", quote: "100x faster than everything", source: `README.md#L${n}` },
        { text: "bad source", quote: "x", source: "README.md" },
        { text: "dup", quote: "(9.8x faster)", source: `README.md#L${n}` },
      ],
      HYPERFINE.context,
    );
    expect(claims).toEqual([
      { text: "fd is 9.8x faster than find", quote: "(9.8x faster)", source: `README.md#L${n}` },
    ]);
    expect(dropped).toBe(4);
    const v = decideUnderstanding(
      outputTdm56({ claims: [{ text: "t", quote: "nope", source: "README.md#L2" }] }),
      HYPERFINE,
    );
    expect(v.understanding.claims).toEqual([]);
    expect(v.corrections).toContain("dropped 1 claim(s) whose quote is not on the cited line");
  });

  it("UnderstandingExtrasShape is all optional (old stage outputs still parse)", () => {
    for (const [key, schema] of Object.entries(UnderstandingExtrasShape)) {
      expect(schema.safeParse(undefined).success, key).toBe(true);
    }
  });
});
