// TDM-178 [16.7]: comparable setups or no comparison (plan.md 17.2 rule 4).
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KitSpecSchema, type KitSpecInput } from "@anybench/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  comparabilityIssues,
  isPinnedGitRef,
  isPinnedModelId,
  isPinnedVersion,
  validateKitDir,
  type ComparabilityIssue,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FLAGSHIP_TDM178 = path.join(here, "../../../kits/tandem-vs-claude-code");

const tmpDirsTdm178: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirsTdm178.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * The flagship kit as it was before TDM-184 [16.13] pinned it: no model, Claude Code and
 * tandem-mcp installed at `latest`, ref main, 8M vs 5M token caps, the reviewer only for Tandem,
 * and A still has the `Agent` tool.
 */
async function brokenFlagshipTdm178(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "anybench-kit-tdm178-"));
  tmpDirsTdm178.push(d);
  await cp(FLAGSHIP_TDM178, d, { recursive: true });
  const edit = async (rel: string, f: (t: string) => string) => {
    const p = path.join(d, rel);
    await writeFile(p, f(await readFile(p, "utf8")));
  };
  await edit("anybench.yaml", (t) => {
    const i = t.lastIndexOf("token_cap_tokens: 8000000");
    return `${t.slice(0, i)}token_cap_tokens: 5000000${t.slice(i + "token_cap_tokens: 8000000".length)}`
      .replace(/^ {6}model: .*\n/gm, "")
      .replace(/^ {4}versions: .*\n/gm, "")
      .replace('CC_DISALLOWED_TOOLS: "Task Agent"', "CC_DISALLOWED_TOOLS: Task")
      .replace(/ref: [0-9a-f]{40}/, "ref: main")
      .replace("policy: auto", "policy: llm-reviewer")
      .replace(/\nschedule:\n(?: {2}.*\n)+/, "\n");
  });
  for (const s of ["adapters/claude-code/install.sh", "adapters/tandem/install.sh"])
    await edit(s, (t) =>
      t
        .replace(/CLAUDE_CODE_VERSION:-[0-9.]+/g, "CLAUDE_CODE_VERSION:-latest")
        .replace(/TANDEM_MCP_VERSION:-[0-9.]+/g, "TANDEM_MCP_VERSION:-latest"),
    );
  return d;
}

describe("kits/tandem-vs-claude-code (pinned by TDM-184 [16.13])", () => {
  it("passes validation: pinned model, versions and ref, equal caps, no one-sided reviewer", async () => {
    const r = await validateKitDir(FLAGSHIP_TDM178);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const codes = r.warnings.map((w) => w.code);
    expect(codes).not.toContain("token_cap_deprecated");
    expect(codes).not.toContain("order_not_rotated");
  });

  it("its pre-TDM-184 form fails, naming the unpinned model, claude-code@latest, ref main and 8M vs 5M", async () => {
    const r = await validateKitDir(await brokenFlagshipTdm178());
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => [e.code, e.path])).toEqual([
      ["version_unpinned", "contenders[0].install.script"],
      ["model_unpinned", "contenders[0].driver"],
      ["subagents_not_disabled", "contenders[0].driver.env.CC_DISALLOWED_TOOLS"],
      ["version_unpinned", "contenders[1].install.script"],
      ["model_unpinned", "contenders[1].driver"],
      ["ref_unpinned", "contenders[2].source.ref"],
      // TDM-41: install-tandem.sh pins the Tandem server and gateway; only claude-code@latest is left.
      ["version_unpinned", "contenders[2].install.script"],
      ["model_unpinned", "contenders[2].driver"],
      ["caps_unequal", "contenders[2].driver.token_cap_tokens"],
      ["assist_unequal", "human_in_loop.policy"],
    ]);
    const text = r.lines.join("\n");
    expect(text).toMatch(/driver\.model is not set/);
    expect(text).toMatch(/installs @anthropic-ai\/claude-code@latest unless CLAUDE_CODE_VERSION/);
    expect(text).not.toMatch(/tandem-mcp@latest/);
    expect(text).toMatch(/ref 'main' of jaximus808\/tandem/);
    expect(text).toMatch(/claude-code-solo 8000000, claude-code-subagents 8000000, tandem 5000000/);
    expect(text).toMatch(/'llm-reviewer' must reach every contender or none/);
    expect(text).toMatch(/disallows 'Task' but not 'Agent'/);
    // Each error points at the line of the field in anybench.yaml.
    for (const e of r.errors) expect(e.line, `${e.code} ${e.path}`).toBeGreaterThan(0);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["order_not_rotated"]));
  });

  it("an unequal cap with unequal_caps_reason is a warning, not an error", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "anybench-kit-tdm178-"));
    tmpDirsTdm178.push(d);
    await cp(FLAGSHIP_TDM178, d, { recursive: true });
    const y = path.join(d, "anybench.yaml");
    const text = await readFile(y, "utf8");
    const i = text.lastIndexOf("token_cap_tokens: 8000000");
    await writeFile(
      y,
      `${text.slice(0, i)}token_cap_tokens: 9000000${text.slice(i + "token_cap_tokens: 8000000".length)}` +
        "unequal_caps_reason: Tandem runs a planner and N workers, so it gets the per-worker budget\n",
    );
    const r = await validateKitDir(d);
    expect(r.lines).toEqual([]);
    const capWarnings = r.warnings.filter((w) => w.code === "caps_unequal");
    expect(capWarnings).toHaveLength(1);
    expect(capWarnings[0]!.message).toMatch(/allowed by unequal_caps_reason: Tandem runs/);
  });
});

// ---------------------------------------------------------------------------------------------

const agentTdm178 = (id: string, driver: Record<string, unknown> = {}, extra = {}) => ({
  id,
  role: id === "a" ? ("subject" as const) : ("baseline" as const),
  source: { upload: ["CLAUDE.md"] },
  driver: {
    type: "coding-agent" as const,
    verbs: { run: "x" },
    model: "claude-sonnet-4-5-20250929",
    ...driver,
  },
  ...extra,
});

function specTdm178(over: Partial<KitSpecInput> = {}) {
  const input: KitSpecInput = {
    schema_version: 2,
    subject: { kind: "agent", name: "a", summary: "s", better_means: ["b"] },
    contenders: [agentTdm178("a"), agentTdm178("b")],
    workloads: [{ id: "w", title: "w" }],
    gates: [{ id: "g", kind: "hidden-tests" }],
    requirements: [
      { id: "r", type: "measured", title: "t", metric: "m", better: "higher", gate_id: "g" },
    ],
    proof: { oracle: { id: "o", dir: "proof/oracle/" }, do_less: [] },
    scoring: { weights: { r: 100 } },
    repeats: 3,
    schedule: { order_seed: 1 },
    ...over,
  };
  return KitSpecSchema.parse(input);
}

const errorsTdm178 = (issues: ComparabilityIssue[]) =>
  issues.filter((i) => i.severity === "error").map((i) => [i.code, i.at.join(".")]);

describe("comparabilityIssues", () => {
  it("a comparable kit has no issues", () => {
    expect(comparabilityIssues(specTdm178())).toEqual([]);
  });

  it("caps must match unless the cap is the vary axis", () => {
    const contenders = [
      agentTdm178("a", { wall_clock_cap_s: 600, token_cap_micro_usd: 2_000_000, max_turns: 50 }),
      agentTdm178("b", { wall_clock_cap_s: 900, token_cap_micro_usd: "2000000", max_turns: 80 }),
    ];
    expect(errorsTdm178(comparabilityIssues(specTdm178({ contenders })))).toEqual([
      ["caps_unequal", "contenders.1.driver.wall_clock_cap_s"],
      ["caps_unequal", "contenders.1.driver.max_turns"],
    ]);
    const varied = specTdm178({ contenders, vary: { WALL_CLOCK_CAP_S: [600, 900] } });
    expect(errorsTdm178(comparabilityIssues(varied))).toEqual([
      ["caps_unequal", "contenders.1.driver.max_turns"],
    ]);
  });

  it("a cap set on one contender and missing on another is unequal", () => {
    const issues = comparabilityIssues(
      specTdm178({
        contenders: [agentTdm178("a", { token_cap_tokens: 100 }), agentTdm178("b")],
      }),
    );
    expect(errorsTdm178(issues)).toEqual([["caps_unequal", "contenders.1.driver"]]);
    expect(issues[0]!.message).toMatch(/a 100, b none/);
  });

  it("legacy token_cap counts as tokens; setting both is a conflict", () => {
    const same = comparabilityIssues(
      specTdm178({
        contenders: [
          agentTdm178("a", { token_cap: 100 }),
          agentTdm178("b", { token_cap_tokens: 100 }),
        ],
      }),
    );
    expect(errorsTdm178(same)).toEqual([]);
    expect(same.map((i) => i.code)).toEqual(["token_cap_deprecated"]);
    const both = comparabilityIssues(
      specTdm178({
        contenders: [
          agentTdm178("a", { token_cap: 100, token_cap_tokens: 100 }),
          agentTdm178("b", { token_cap_tokens: 100 }),
        ],
      }),
    );
    expect(errorsTdm178(both)).toEqual([["token_cap_conflict", "contenders.0.driver.token_cap"]]);
  });

  it("refuses model aliases and a missing model; different pinned models only warn", () => {
    const issues = comparabilityIssues(
      specTdm178({
        contenders: [
          agentTdm178("a", { model: "sonnet" }),
          agentTdm178("b", { model: undefined }),
          agentTdm178("c", { model: "claude-3-5-sonnet-latest" }),
        ],
      }),
    );
    expect(errorsTdm178(issues)).toEqual([
      ["model_unpinned", "contenders.0.driver.model"],
      ["model_unpinned", "contenders.1.driver"],
      ["model_unpinned", "contenders.2.driver.model"],
    ]);
    const mixed = comparabilityIssues(
      specTdm178({
        contenders: [agentTdm178("a"), agentTdm178("b", { model: "gpt-5-2025-08-07" })],
      }),
    );
    expect(mixed.map((i) => [i.severity, i.code])).toEqual([["warning", "model_mismatch"]]);
  });

  it("versions must be pinned and equal across contenders unless varied", () => {
    const contenders = [
      agentTdm178("a", {}, { versions: { CLAUDE_CODE_VERSION: "2.0.14" } }),
      agentTdm178("b", {}, { versions: { CLAUDE_CODE_VERSION: "2.0.10" } }),
      agentTdm178("c", {}, { versions: { CLAUDE_CODE_VERSION: "latest" } }),
    ];
    expect(errorsTdm178(comparabilityIssues(specTdm178({ contenders })))).toEqual([
      ["version_unpinned", "contenders.2.versions.CLAUDE_CODE_VERSION"],
      ["version_mismatch", "contenders.1.versions.CLAUDE_CODE_VERSION"],
    ]);
    const varied = specTdm178({
      contenders: contenders.slice(0, 2),
      vary: { CLAUDE_CODE_VERSION: ["2.0.14", "2.0.10"] },
    });
    expect(errorsTdm178(comparabilityIssues(varied))).toEqual([]);
  });

  it("scans adapter scripts for latest fallbacks and unversioned installs", () => {
    const spec = specTdm178({
      contenders: [
        agentTdm178("a", {}, { versions: { CLAUDE_CODE_VERSION: "2.0.14" } }),
        agentTdm178("b", { env: { TOOL_VERSION: "1.2.3" } }),
      ],
    });
    const script = (contender: number, text: string) => ({
      contender,
      path: `adapters/x${contender}/install.sh`,
      field: ["install", "script"],
      text,
    });
    const issues = comparabilityIssues(spec, [
      script(0, 'npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-latest}"\n'),
      script(
        1,
        [
          "# npm install -g ignored-in-a-comment",
          'npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-latest}"',
          'npm install -g "tool@${TOOL_VERSION:-main}" left-pad@1.3.0 --prefix /opt',
          "npm install -g typescript && npx tsc --version && npx -y cowsay@next hi",
          'echo "${OPTIONAL_FLAG:-}"',
        ].join("\n"),
      ),
    ]);
    expect(issues.map((i) => i.message)).toEqual([
      "adapters/x1/install.sh installs @anthropic-ai/claude-code@latest unless CLAUDE_CODE_VERSION is set: pin it in contenders[1].versions.CLAUDE_CODE_VERSION",
      "adapters/x1/install.sh installs typescript (no version, so latest): pin the version (e.g. pkg@${PKG_VERSION} with versions.PKG_VERSION)",
      "adapters/x1/install.sh installs cowsay@next: pin the version (e.g. pkg@${PKG_VERSION} with versions.PKG_VERSION)",
    ]);
  });

  it("every assist goes to every contender or to none", () => {
    const one = comparabilityIssues(
      specTdm178({
        contenders: [agentTdm178("a", {}, { assists: ["web-search"] }), agentTdm178("b")],
      }),
    );
    expect(errorsTdm178(one)).toEqual([["assist_unequal", "contenders.0.assists.0"]]);
    expect(one[0]!.message).toMatch(
      /assist 'web-search' must reach every contender or none, but b does not/,
    );

    const all = comparabilityIssues(
      specTdm178({
        contenders: [
          agentTdm178("a", {}, { assists: ["web-search"] }),
          agentTdm178("b", {}, { assists: ["web-search"] }),
        ],
      }),
    );
    expect(errorsTdm178(all)).toEqual([]);

    // An approval policy other than auto is an assist too.
    const reviewer = comparabilityIssues(
      specTdm178({
        human_in_loop: { kind: "tandem", policy: "human-sim" },
        contenders: [agentTdm178("a", {}, { assists: ["human-sim"] }), agentTdm178("b")],
      }),
    );
    expect(errorsTdm178(reviewer)).toEqual([["assist_unequal", "human_in_loop.policy"]]);
    const auto = comparabilityIssues(
      specTdm178({ human_in_loop: { kind: "tandem", policy: "auto" } }),
    );
    expect(errorsTdm178(auto)).toEqual([]);
  });

  it("disabling subagents needs both Task and Agent (followup 16)", () => {
    const withTools = (v: string) =>
      errorsTdm178(
        comparabilityIssues(
          specTdm178({
            contenders: [agentTdm178("a", { env: { CC_DISALLOWED_TOOLS: v } }), agentTdm178("b")],
          }),
        ),
      );
    expect(withTools("Task")).toEqual([
      ["subagents_not_disabled", "contenders.0.driver.env.CC_DISALLOWED_TOOLS"],
    ]);
    expect(withTools("Agent,WebFetch")).toEqual([
      ["subagents_not_disabled", "contenders.0.driver.env.CC_DISALLOWED_TOOLS"],
    ]);
    expect(withTools("Task Agent")).toEqual([]);
    expect(withTools("WebFetch")).toEqual([]);
  });

  it("software kits: refs must be pinned, order_seed missing only warns", () => {
    const cli = (id: string, ref: string) => ({
      id,
      role: id === "a" ? ("subject" as const) : ("baseline" as const),
      source: { github: "o/r", ref },
      driver: { type: "cli" as const, verbs: { run: "x" } },
    });
    const kit = KitSpecSchema.parse({
      ...specTdm178(),
      contenders: [cli("a", "main"), cli("b", "v1.2.0")],
      schedule: undefined,
    });
    const issues = comparabilityIssues(kit);
    expect(issues.map((i) => [i.severity, i.code, i.at.join(".")])).toEqual([
      ["error", "ref_unpinned", "contenders.0.source.ref"],
      ["warning", "order_not_rotated", "schedule"],
    ]);
  });
});

describe("http-agent contenders", () => {
  const httpAgent = (
    extra: Record<string, unknown> = {},
    driver: Record<string, unknown> = {},
  ) => ({
    id: "bot",
    role: "subject" as const,
    source: { upload: ["server.ts"] },
    driver: { type: "http-agent" as const, verbs: { run: "x" }, ...driver },
    ...extra,
  });
  const issuesOf = (c: ReturnType<typeof httpAgent>) =>
    comparabilityIssues(specTdm178({ contenders: [c] })).map((i) => [i.severity, i.code]);

  it("need no driver.model (the model is the service's), but warn when the service is unpinned", () => {
    expect(issuesOf(httpAgent())).toEqual([["warning", "service_unpinned"]]);
    expect(issuesOf(httpAgent({ version: "bot@stub" }))).toEqual([["warning", "service_unpinned"]]);
  });

  it.each([
    ["versions", { versions: { BOT_VERSION: "1.4.2" } }],
    ["a pinned version", { version: "bot@1.4.2" }],
    ["a binary sha256", { source: { binary_url: "https://x.test/bot", sha256: "a".repeat(64) } }],
    ["a pinned github ref", { source: { github: "o/bot", ref: "v1.4.2" } }],
  ])("a service pinned by %s has no issues", (_what, extra) => {
    expect(issuesOf(httpAgent(extra))).toEqual([]);
  });
});

describe("pin predicates", () => {
  it.each([
    ["2.0.14", true],
    ["v2.0.14", true],
    ["1.2.3-beta.1", true],
    ["1.2.3+build.5", true],
    ["1.2.3-rc.1+sha.abc", true],
    ["0123abc", true],
    ["deadbeef", true],
    ["v1", false],
    ["2", false],
    ["v2", false],
    ["2.0", false],
    ["1.2", false],
    ["rc1", false],
    ["next-2", false],
    ["latest", false],
    ["main", false],
    ["^2.0.0", false],
    ["~1.2", false],
    ["1.x", false],
    [">=1", false],
    ["*", false],
    ["", false],
  ])("isPinnedVersion(%j) = %s", (v, ok) => expect(isPinnedVersion(v)).toBe(ok));

  it.each([
    ["0123456789abcdef0123456789abcdef01234567", true],
    ["a1b2c3d", true],
    ["v0.1.0", true],
    ["14.1.1", true],
    ["ripgrep-14.1.1", true],
    ["refs/tags/v2.0.0", true],
    ["refs/tags/tool/v1.2.3", true],
    ["v1", false],
    ["1", false],
    ["v1.2", false],
    ["release/1.2", false],
    ["release/1.2.3", false],
    ["stable-2", false],
    ["main", false],
    ["master", false],
    ["HEAD", false],
    ["refs/heads/main", false],
    ["refs/tags/v1", false],
    ["feature-x", false],
  ])("isPinnedGitRef(%j) = %s", (v, ok) => expect(isPinnedGitRef(v)).toBe(ok));

  it.each([
    ["claude-sonnet-4-5-20250929", true],
    ["claude-opus-4-1-20250805", true],
    ["gpt-5-2025-08-07", true],
    ["gpt-4o-2024-08-06", true],
    ["o3-2025-04-16", true],
    ["gpt-4-0613", true], // UNDATED_MODEL_SNAPSHOTS
    ["claude-opus-5-5", true], // TDM-212: Anthropic ids from 4.6 on are the snapshot itself
    ["claude-opus-4-6", true],
    ["gemini-2.5-pro", true], // other providers: digit heuristic
    ["llama-3.1-70b-instruct", true],
    ["claude-sonnet-4-5", false],
    ["claude-opus-4-1", false],
    ["gpt-5", false],
    ["gpt-4o", false],
    ["o3", false],
    ["o4-mini", false],
    ["sonnet", false],
    ["opus", false],
    ["claude-3-5-sonnet-latest", false],
    ["default", false],
  ])("isPinnedModelId(%j) = %s", (v, ok) => expect(isPinnedModelId(v)).toBe(ok));
});
