// TDM-184 [16.13] phase 1: the flagship kit (kits/tandem-vs-claude-code) is comparable and its
// gates follow the gate runner's calling convention.
// - Every contender runs the same pinned model, the same pinned Claude Code, the same caps, and no
//   assist only one of them gets (plan.md 17.2 rule 4, TDM-178).
// - The adapter scripts install exactly the versions the kit pins (nothing plumbs `versions` into
//   install.sh yet, so the scripts' own defaults must match).
// - todo-api no longer hands every contender a ticket split; Tandem ×1 is a setup.
// - gates/*/check.sh take `<frozen-out> <workload-id> <gate.json>` and run contender code only
//   through $AB_RUN in $AB_RUN_DIR (packages/bench gate.ts, TDM-51). The oracle still passes every
//   hidden test through them; the untouched starting repo fails every one.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentDriver, safeParseKitSpec, type KitSpec } from "@anybench/core";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isPinnedGitRef, isPinnedModelId, isPinnedVersion } from "../src/index.js";

const KIT_TDM184 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../kits/tandem-vs-claude-code",
);
const AB_RUN_TDM184 = join(KIT_TDM184, "scripts/ab-run-local.sh");

function kitTdm184(): KitSpec {
  const r = safeParseKitSpec(parse(readFileSync(join(KIT_TDM184, "anybench.yaml"), "utf8")));
  if (!r.success) throw new Error(r.errors.join("\n"));
  return r.data;
}

const readKitTdm184 = (p: string) => readFileSync(join(KIT_TDM184, p), "utf8");

describe("kits/tandem-vs-claude-code v2: comparable setups", () => {
  const kit = kitTdm184();

  it("every contender runs the same dated model, passed to Claude Code as CC_MODEL", () => {
    const models = kit.contenders.map((c) =>
      isAgentDriver(c.driver) ? c.driver.model : undefined,
    );
    expect(new Set(models).size).toBe(1);
    expect(isPinnedModelId(models[0]!)).toBe(true);
    expect(models[0]).toMatch(/-\d{8}$/);
    for (const c of kit.contenders) expect(c.driver.env?.CC_MODEL, c.id).toBe(models[0]);
    // The drivers refuse to run without it rather than fall back to the CLI's default model.
    for (const d of ["adapters/claude-code/driver.sh", "adapters/tandem/driver.sh"])
      expect(readKitTdm184(d), d).toMatch(/CC_MODEL:\?/);
  });

  it("every contender pins the same Claude Code, and the install scripts default to exactly it", () => {
    const cc = kit.contenders.map((c) => c.versions?.CLAUDE_CODE_VERSION);
    expect(new Set(cc).size).toBe(1);
    expect(isPinnedVersion(cc[0]!)).toBe(true);
    for (const s of ["adapters/claude-code/install.sh", "adapters/tandem/install.sh"])
      expect(readKitTdm184(s), s).toContain(`\${CLAUDE_CODE_VERSION:-${cc[0]}}`);
    const tandem = kit.contenders.find((c) => c.id === "tandem")!;
    const mcp = tandem.versions?.TANDEM_MCP_VERSION;
    expect(isPinnedVersion(mcp!)).toBe(true);
    for (const s of [
      "adapters/tandem/install.sh",
      "adapters/tandem/healthcheck.sh",
      "adapters/tandem/driver.sh",
    ])
      expect(readKitTdm184(s), s).toContain(`\${TANDEM_MCP_VERSION:-${mcp}}`);
    // No script installs whatever is newest.
    for (const s of ["install.sh", "healthcheck.sh", "driver.sh"].flatMap((f) => [
      `adapters/claude-code/${f}`,
      `adapters/tandem/${f}`,
    ]))
      expect(readKitTdm184(s), s).not.toMatch(/latest/);
  });

  it("pins Tandem to a commit SHA", () => {
    const tandem = kit.contenders.find((c) => c.id === "tandem")!;
    expect(tandem.source).toMatchObject({ github: "jaximus808/tandem" });
    const ref = "github" in tandem.source ? tandem.source.ref : "";
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
    expect(isPinnedGitRef(ref)).toBe(true);
  });

  it("gives every contender the same caps", () => {
    for (const key of [
      "wall_clock_cap_s",
      "token_cap_tokens",
      "token_cap_micro_usd",
      "max_turns",
    ] as const) {
      const values = kit.contenders.map((c) => (c.driver as Record<string, unknown>)[key]);
      expect(new Set(values).size, key).toBe(1);
    }
    for (const c of kit.contenders)
      expect((c.driver as Record<string, unknown>).token_cap, c.id).toBeUndefined();
    expect(kit.unequal_caps_reason).toBeUndefined();
  });

  it("disables A's subagents under both names, rotates the order, and varies Tandem ×1/×3/×5", () => {
    expect(kit.contenders[0]!.driver.env?.CC_DISALLOWED_TOOLS?.split(/\s+/).sort()).toEqual([
      "Agent",
      "Task",
    ]);
    expect(kit.schedule.order_seed).toBeTypeOf("number");
    expect(kit.vary).toEqual({ TANDEM_WORKERS: [1, 3, 5] });
    expect(kit.human_in_loop?.policy).toBe("auto");
    for (const c of kit.contenders) expect(c.assists ?? [], c.id).toEqual([]);
  });

  it("todo-api no longer hands out a ticket split (the planner's job)", () => {
    expect(readKitTdm184("workloads/todo-api/instruction.md")).not.toMatch(
      /suggested tickets|five mostly independent/i,
    );
    const todo = kit.workloads.find((w) => w.id === "todo-api")!;
    expect(todo.params ?? {}).not.toHaveProperty("suggested_tickets");
  });

  it("bug-hunt is described as a planted bug, with no invented release history in its task", () => {
    const instruction = readKitTdm184("workloads/bug-hunt/instruction.md");
    expect(instruction).not.toMatch(/worked in 1\.3|after the 1\.4\.0 release/);
    expect(readKitTdm184("workloads/bug-hunt/PROVENANCE.md")).toMatch(
      /not mined from a real project/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Gates under the runner's convention, run on the host with the local $AB_RUN (no uid switch; the
// uid split itself is covered by packages/bench gate-docker-tdm51 on the TDM-51 branch).

describe("kits/tandem-vs-claude-code v2: gates use the gate runner's calling convention", () => {
  const root = mkdtempSync(join(tmpdir(), "tdm184-gates-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A fresh workspace for `workload` (setup.sh), with the oracle applied when asked. */
  function workspaceTdm184(name: string, workload: string, oracle: boolean): string {
    const ws = join(root, name, "ws");
    mkdirSync(dirname(ws), { recursive: true });
    const setup = spawnSync(join(KIT_TDM184, "workloads", workload, "setup.sh"), [ws], {
      encoding: "utf8",
    });
    expect(setup.status, setup.stderr).toBe(0);
    if (oracle) {
      const r = spawnSync(join(KIT_TDM184, "proof/oracle/driver.sh"), ["run", "task", ws], {
        env: { ...process.env, WORKLOAD: workload },
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
    }
    return ws;
  }

  /** `check.sh <frozen-out> <workload-id> <gate.json>` with AB_RUN / AB_RUN_DIR, as the runner calls it. */
  function runGateTdm184(
    gate: string,
    workload: string,
    ws: string | null,
    name: string,
    env: Record<string, string> = {},
  ) {
    const d = join(root, name, gate);
    mkdirSync(join(d, "out"), { recursive: true });
    mkdirSync(join(d, "run"), { recursive: true });
    mkdirSync(join(d, "home"), { recursive: true });
    if (ws !== null) cpSync(ws, join(d, "run", "workspace"), { recursive: true });
    const verdict = join(d, "gate.json");
    const r = spawnSync(
      "bash",
      [join(KIT_TDM184, "gates", gate, "check.sh"), join(d, "out"), workload, verdict],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          AB_RUN: AB_RUN_TDM184,
          AB_RUN_DIR: join(d, "run"),
          AB_RUN_HOME: join(d, "home"),
          ...env,
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const gateJson = existsSync(verdict)
      ? (JSON.parse(readFileSync(verdict, "utf8")) as Record<string, unknown>)
      : null;
    return { status: r.status, stderr: r.stderr, gate: gateJson, out: join(d, "out") };
  }

  it.each([
    ["todo-api", 16],
    ["auth-refactor", 14],
    ["bug-hunt", 12],
  ] as const)(
    "%s: the oracle passes all %i hidden tests; the starting repo fails every one",
    (workload, n) => {
      const good = runGateTdm184(
        "hidden-tests",
        workload,
        workspaceTdm184(`oracle-${workload}`, workload, true),
        `oracle-${workload}`,
      );
      expect(good.status, good.stderr).toBe(0);
      expect(good.gate).toEqual({
        pass: true,
        reason: `${n}/${n} hidden tests passed`,
        evidence: ["hidden-tests.json", "hidden-tests.log"],
      });
      const bad = runGateTdm184(
        "hidden-tests",
        workload,
        workspaceTdm184(`noop-${workload}`, workload, false),
        `noop-${workload}`,
      );
      expect(bad.status).toBe(0);
      expect(bad.gate).toMatchObject({ pass: false });
      expect(String(bad.gate!.reason)).toMatch(new RegExp(`^0/${n} hidden tests passed`));
    },
    120_000,
  );

  it("api-load: the oracle gets a p95 only after its hidden tests pass; other workloads are not applicable", () => {
    const ws = workspaceTdm184("load-oracle", "todo-api", true);
    const r = runGateTdm184("api-load", "todo-api", ws, "load-oracle", {
      LOAD_DURATION_S: "2",
      LOAD_RPS: "20",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.gate).toMatchObject({
      pass: true,
      evidence: ["api-load.json", "api-load-hidden/hidden-tests.json"],
    });
    expect(readFileSync(join(r.out, "api-load.metrics.jsonl"), "utf8")).toMatch(
      /"metric":"api_p95_ms"/,
    );
    const noop = runGateTdm184(
      "api-load",
      "todo-api",
      workspaceTdm184("load-noop", "todo-api", false),
      "load-noop",
    );
    expect(noop.gate).toMatchObject({ pass: false });
    expect(String(noop.gate!.reason)).toMatch(/^no latency without correctness/);
    const na = runGateTdm184("api-load", "bug-hunt", null, "load-na");
    expect(na.gate).toMatchObject({ pass: false, applicable: false });
  }, 120_000);

  it("planted .hidden-tests, process.exit(0) on import and missing outputs all FAIL, never pass", () => {
    const ws = workspaceTdm184("cheat", "bug-hunt", false);
    // A passing decoy test where the hidden tests go, and an import that exits 0 before any test reports.
    mkdirSync(join(ws, ".hidden-tests"));
    writeFileSync(
      join(ws, ".hidden-tests", "csv-quoting.test.ts"),
      'import { test } from "node:test";\ntest("x", () => {});\n',
    );
    writeFileSync(join(ws, "src", "csv.ts"), "process.exit(0);\n");
    const r = runGateTdm184("hidden-tests", "bug-hunt", ws, "cheat");
    expect(r.status).toBe(0);
    expect(r.gate).toMatchObject({ pass: false });
    expect(String(r.gate!.reason)).toMatch(/^0\/12 hidden tests passed/);

    const empty = runGateTdm184("hidden-tests", "bug-hunt", null, "empty");
    expect(empty.status).toBe(0);
    expect(empty.gate).toEqual({
      pass: false,
      reason: "the outputs have no workspace/",
      evidence: [],
    });
  }, 120_000);

  it("a check killed mid-run still leaves a FAIL verdict (EXIT trap); kit errors and a missing $AB_RUN exit non-zero", () => {
    const killer = join(root, "killer.sh");
    writeFileSync(killer, "#!/usr/bin/env bash\nkill -9 $PPID\n", { mode: 0o755 });
    const ws = workspaceTdm184("killed", "bug-hunt", true);
    const r = runGateTdm184("hidden-tests", "bug-hunt", ws, "killed", { AB_RUN: killer });
    expect(r.status).toBe(0);
    expect(r.gate).toMatchObject({
      pass: false,
      reason: expect.stringMatching(/could not run on these outputs/),
    });

    const kitError = runGateTdm184("hidden-tests", "no-such-workload", ws, "kit-error");
    expect(kitError.status).toBe(2);
    expect(kitError.gate).toBeNull();

    const d = join(root, "no-ab-run");
    mkdirSync(d, { recursive: true });
    const noAbRun = spawnSync(
      "bash",
      [join(KIT_TDM184, "gates/hidden-tests/check.sh"), d, "bug-hunt", join(d, "gate.json")],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      },
    );
    expect(noAbRun.status).not.toBe(0);
    expect(noAbRun.stderr).toMatch(/no AB_RUN/);
  }, 120_000);
});
