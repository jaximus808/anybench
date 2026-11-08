// TDM-55 [6.1]: the role registry and the deploy sync, on FakeNaive (no network, no spend).
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_FINGERPRINT_KEY, AGENT_ROLE_KEY } from "@anybench/naive";
import { FakeNaive, fakeNaiveError } from "@anybench/naive/fake";
import { describe, expect, it } from "vitest";
import {
  listRoles,
  loadRole,
  planSync,
  RoleError,
  roleAgentSpec,
  syncAgents,
  syncMain,
} from "../src/index.js";

const FIXTURE_ROLES = fileURLToPath(new URL("./fixtures-tdm55/roles/", import.meta.url));

/** A scratch copy of the fixture roles, so a test can edit a prompt. */
function scratchRolesTdm55(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tdm55-roles-"));
  cpSync(FIXTURE_ROLES, dir, { recursive: true });
  return dir;
}

function cliIoTdm55(client?: () => FakeNaive) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (l: string) => out.push(l),
      stderr: (l: string) => err.push(l),
      env: {},
      client: () => {
        if (!client) throw new Error("the CLI must not build a Naïve client here");
        return client();
      },
    },
  };
}

describe("role registry (TDM-55)", () => {
  it("loads a role folder: prompt, config (micro-USD as bigint), output schema", () => {
    const def = loadRole("echo", { rolesDir: FIXTURE_ROLES });
    expect(def.role).toBe("echo");
    expect(def.prompt).toContain("test fixture agent");
    expect(def.config.budget).toEqual({
      cap_micro_usd: 1_000_000n,
      max_task_micro_usd: 50_000n,
      period: "day",
    });
    expect(def.outputSchema).toMatchObject({ required: ["echo", "length"] });
    expect(def.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists only directories with a config.json", () => {
    const dir = scratchRolesTdm55();
    mkdirSync(path.join(dir, "not-a-role"));
    writeFileSync(path.join(dir, "README.md"), "x");
    expect(listRoles({ rolesDir: dir })).toEqual(["echo"]);
  });

  it("every committed role folder in the package loads", () => {
    // src/, test/, dist/ and node_modules/ have no config.json, so they are never roles.
    for (const role of listRoles()) expect(loadRole(role).role).toBe(role);
    expect(listRoles()).not.toContain("src");
  });

  it("refuses a malformed config, a name mismatch and a missing prompt", () => {
    const dir = scratchRolesTdm55();
    const cfg = path.join(dir, "echo", "config.json");
    const good = readFileSync(cfg, "utf8");

    writeFileSync(cfg, good.replace('"max_task_micro_usd": 50000', '"max_task_micro_usd": 0.5'));
    expect(() => loadRole("echo", { rolesDir: dir })).toThrow(/max_task_micro_usd/);

    writeFileSync(cfg, good.replace('"cap_micro_usd": 1000000', '"cap_micro_usd": 10'));
    expect(() => loadRole("echo", { rolesDir: dir })).toThrow(/at most budget.cap_micro_usd/);

    writeFileSync(cfg, good.replace('"configs": {}', '"other": {}'));
    expect(() => loadRole("echo", { rolesDir: dir })).toThrow(/tools.configs/);

    writeFileSync(cfg, good.replace('"role": "echo"', '"role": "other"'));
    expect(() => loadRole("echo", { rolesDir: dir })).toThrow(/must match/);

    expect(() => loadRole("missing", { rolesDir: dir })).toThrow(RoleError);
    expect(() => loadRole("../etc", { rolesDir: dir })).toThrow(/not a role name/);
  });

  it("roleAgentSpec maps config.json onto the ensureAgent spec", () => {
    const spec = roleAgentSpec("echo", { rolesDir: FIXTURE_ROLES });
    expect(spec).toMatchObject({
      role: "echo",
      model: "deepseek/deepseek-v4-flash-0731",
      harness: "pi",
      window: "immediate",
      budget: { capMicroUsd: 1_000_000n, maxTaskMicroUsd: 50_000n, period: "day" },
      tools: { default_config: { permission: "deny" }, configs: {} },
    });
    expect(spec.system).toContain("test fixture agent");
    expect(spec.outputSchema).toMatchObject({ type: "object" });
    // A per-task cap above the role cap raises the cap (Naïve requires max_task <= cap).
    const big = roleAgentSpec("echo", { rolesDir: FIXTURE_ROLES, maxTaskMicroUsd: 2_000_000n });
    expect(big.budget).toMatchObject({ capMicroUsd: 2_000_000n, maxTaskMicroUsd: 2_000_000n });
    expect(
      roleAgentSpec("echo", { rolesDir: FIXTURE_ROLES, outputSchema: null }),
    ).not.toHaveProperty("outputSchema");
  });
});

describe("syncAgents on FakeNaive (TDM-55)", () => {
  it("creates, is a no-op when unchanged, and mints a new version only when the prompt changes", async () => {
    const dir = scratchRolesTdm55();
    const naive = new FakeNaive();

    const [created] = await syncAgents(naive, { rolesDir: dir });
    expect(created).toMatchObject({ role: "echo", action: "created" });
    expect(created!.agent).toMatchObject({ name: "anybench-echo", version: 1 });
    expect(created!.agent.metadata).toMatchObject({
      [AGENT_ROLE_KEY]: "echo",
      [AGENT_FINGERPRINT_KEY]: created!.fingerprint,
    });

    const writesBefore = naive.calls.filter((c) => /agents\.(create|update)/.test(c.method)).length;
    const [unchanged] = await syncAgents(naive, { rolesDir: dir });
    expect(unchanged).toMatchObject({ action: "unchanged", fingerprint: created!.fingerprint });
    expect(unchanged!.agent.version).toBe(1);
    expect(naive.calls.filter((c) => /agents\.(create|update)/.test(c.method)).length).toBe(
      writesBefore,
    );

    // Formatting the JSON differently is not a change; editing the prompt is.
    const cfg = path.join(dir, "echo", "config.json");
    writeFileSync(cfg, JSON.stringify(JSON.parse(readFileSync(cfg, "utf8"))));
    expect((await syncAgents(naive, { rolesDir: dir }))[0]!.action).toBe("unchanged");

    const prompt = path.join(dir, "echo", "prompt.md");
    writeFileSync(prompt, `${readFileSync(prompt, "utf8")}\nAlways answer in lowercase.\n`);
    const [updated] = await syncAgents(naive, { rolesDir: dir });
    expect(updated).toMatchObject({ action: "updated" });
    expect(updated!.fingerprint).not.toBe(created!.fingerprint);
    expect(updated!.agent.id).toBe(created!.agent.id);
    expect(updated!.agent.version).toBe(2);
    const versions = naive.agentVersions(created!.agent.id);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.system).toContain("Always answer in lowercase.");
    expect(versions[1]!.structuredOutputRequired).toBe(true);

    expect((await syncAgents(naive, { rolesDir: dir }))[0]!.action).toBe("unchanged");
    expect(naive.allAgents()).toHaveLength(1);
  });

  it("syncs only the roles asked for, and a model override is a new version", async () => {
    const naive = new FakeNaive();
    expect(await syncAgents(naive, { rolesDir: FIXTURE_ROLES, roles: [] })).toEqual([]);
    await syncAgents(naive, { rolesDir: FIXTURE_ROLES, roles: ["echo"] });
    const [r] = await syncAgents(naive, {
      rolesDir: FIXTURE_ROLES,
      overrides: { echo: { model: "openai/gpt-5-mini" } },
    });
    expect(r).toMatchObject({
      action: "updated",
      agent: { model: "openai/gpt-5-mini", version: 2 },
    });
  });

  it("retries a 429 at capacity (nothing was written) and rethrows anything else", async () => {
    const naive = new FakeNaive();
    naive.failNext(
      "agents.list",
      fakeNaiveError("rate_limited", 429, "the service is at capacity"),
    );
    naive.failNext(
      "agents.create",
      fakeNaiveError("rate_limited", 429, "the service is at capacity"),
    );
    const waits: number[] = [];
    const retry = { sleep: async (ms: number) => void waits.push(ms), random: () => 0 };
    const [r] = await syncAgents(naive, { rolesDir: FIXTURE_ROLES, retry });
    expect(r).toMatchObject({ action: "created", agent: { version: 1 } });
    expect(waits).toEqual([2000, 4000]);
    expect(naive.allAgents()).toHaveLength(1);

    naive.failNext("agents.list", fakeNaiveError("unauthorized", 401));
    await expect(syncAgents(naive, { rolesDir: FIXTURE_ROLES, retry })).rejects.toMatchObject({
      status: 401,
    });
  });

  it("planSync makes no call and reports the fingerprint ensureAgent will compare", async () => {
    const naive = new FakeNaive();
    const [plan] = planSync({ rolesDir: FIXTURE_ROLES });
    const [synced] = await syncAgents(naive, { rolesDir: FIXTURE_ROLES });
    expect(plan).toMatchObject({ role: "echo", name: "anybench-echo", hasOutputSchema: true });
    expect(plan!.fingerprint).toBe(synced!.fingerprint);
  });
});

describe("sync CLI (TDM-55)", () => {
  it("--dry-run prints the plan without building a client", async () => {
    const { io, out, err } = cliIoTdm55();
    const code = await syncMain(["--dry-run", "--roles-dir", FIXTURE_ROLES], io);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]).toMatch(
      /^plan echo: agent anybench-echo, model deepseek\/deepseek-v4-flash-0731, fingerprint [0-9a-f]{32}/,
    );
    expect(out.at(-1)).toBe("dry run: 1 role(s), no call to Naïve");
  });

  it("syncs through the client and reports created then unchanged", async () => {
    const naive = new FakeNaive();
    const first = cliIoTdm55(() => naive);
    expect(await syncMain(["--roles-dir", FIXTURE_ROLES, "--role", "echo"], first.io)).toBe(0);
    expect(first.out[0]).toMatch(/^created echo: agent anybench-echo \(agt_\w+\) version 1/);
    const second = cliIoTdm55(() => naive);
    expect(await syncMain(["--roles-dir", FIXTURE_ROLES], second.io)).toBe(0);
    expect(second.out[0]).toMatch(/^unchanged echo:/);
  });

  it("fails cleanly on an unknown role or flag", async () => {
    const a = cliIoTdm55();
    expect(
      await syncMain(["--dry-run", "--roles-dir", FIXTURE_ROLES, "--role", "nope"], a.io),
    ).toBe(1);
    expect(a.err[0]).toMatch(/role "nope" has no/);
    const b = cliIoTdm55();
    expect(await syncMain(["--bogus"], b.io)).toBe(2);
  });
});
