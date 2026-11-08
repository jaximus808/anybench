// TDM-41 [4.9] done condition: one Tandem ×2 trial on a toy task completes on docker-local with
// metrics extracted. The harness is real: Tandem 0.2.0 and @jaximus/tandem-mcp 3.2.0 installed by
// the adapter's install-tandem.sh, run.sh starting the server, `init --write`, the built-in
// approver (policy auto), a planner and 2 workers, the completion detector, the board dump and
// the scrub. Only Claude Code is a stand-in (packages/kit/test/fixtures/harness-tdm41/fake-claude):
// it speaks MCP to the real gateway, so the epic, the claims and the completions are real board
// writes, and it costs nothing.
//
// Two computers, as in production: the subject computer gets adapters/tandem/ and the workload
// only; a separate scoring computer gets gates/hidden-tests/ and the frozen outputs and runs the
// check with the gate runner's $AB_RUN convention (contender code as its own uid, TDM-51). The
// no-op do-less overlay must fail the gate and leave no board (0 claims).
//
// Needs Docker and network on first run (GitHub release asset, npm). Skips without a daemon.
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectHarness,
  loadKit,
  parseGateResult,
  planCliStubGate,
  planHarnessStubTrial,
  type CliStubFile,
  type HarnessCollection,
  type LoadedKit,
} from "@anybench/kit";
import { DockerLocalProvider, dockerLocalAvailable, trialTag } from "@anybench/providers";
import type { GateResult } from "@anybench/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const available = await dockerLocalAvailable();
const NS_LABEL_TDM41 = "anybench.test-tdm41";
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const ADAPTER = path.join(REPO, "kits/tandem-vs-claude-code/adapters/tandem");
const TOY_KIT = path.join(REPO, "packages/kit/test/fixtures/harness-tdm41/kit");
const FAKE_CLAUDE = path.join(REPO, "packages/kit/test/fixtures/harness-tdm41/fake-claude");
const TANDEM_HOME = "/home/naive/.anybench/tandem";
const PATH_TDM41 = "/home/naive/fake:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface OutcomeTdm41 {
  label: string;
  runExit: number;
  runStderr: string;
  gate: GateResult;
  collected: HarnessCollection;
  run: Record<string, unknown> | null;
  workspace: string[];
}

describe.skipIf(!available)("Tandem ×2 on docker-local (harness driver, runner stub)", () => {
  const p = new DockerLocalProvider({ baseImage: "node:22", labels: { [NS_LABEL_TDM41]: ns } });
  let kit: LoadedKit;
  let subjectId = "";
  let scoringId = "";
  let home = "";
  let localDir = "";
  const outcomes = new Map<string, OutcomeTdm41>();

  const put = async (id: string, root: string, files: readonly CliStubFile[]) => {
    for (const f of files) await p.putFile(id, `${root}/${f.to}`, f.content, { mode: f.mode });
  };

  beforeAll(async () => {
    localDir = await mkdtemp(path.join(tmpdir(), "tdm41-docker-"));
    const kitDir = path.join(localDir, "kit");
    await cp(TOY_KIT, kitDir, { recursive: true });
    await mkdir(path.join(kitDir, "adapters"), { recursive: true });
    await cp(ADAPTER, path.join(kitDir, "adapters/tandem"), { recursive: true });
    kit = await loadKit(kitDir);

    const [s, g] = await Promise.all([
      p.create({ vcpu: 2, memoryMb: 2048, tags: [trialTag(ns, "subject")] }),
      p.create({ vcpu: 1, memoryMb: 1024, tags: [trialTag(ns, "scoring")] }),
    ]);
    const [si, gi] = await Promise.all([
      p.waitReady(s.id, { timeoutMs: 600_000, intervalMs: 500 }),
      p.waitReady(g.id, { timeoutMs: 600_000, intervalMs: 500 }),
    ]);
    subjectId = si.id;
    scoringId = gi.id;
    home = si.home;

    // Snapshot build, Tandem half of L1 (Claude Code itself is the stand-in, not installed).
    const install = await planHarnessStubTrial(kit, "tandem", "toy", { root: `${home}/install` });
    await put(subjectId, `${home}/install`, install.files);
    const inst = await p.exec(
      subjectId,
      `chown -R naive:naive ${home}/install && runuser -u naive -- env HOME=${home} TANDEM_HOME=${TANDEM_HOME} bash ${home}/install/kit/adapters/tandem/install-tandem.sh`,
      { timeoutMs: 600_000 },
    );
    expect(inst.exitCode, `install-tandem.sh: ${inst.stdout}${inst.stderr}`).toBe(0);
    for (const f of ["claude", "fake-claude.ts"])
      await p.putFile(subjectId, `${home}/fake/${f}`, await readFile(path.join(FAKE_CLAUDE, f)), {
        mode: f === "claude" ? 0o755 : 0o644,
      });
    await p.exec(subjectId, `chown -R naive:naive ${home}/fake`, { timeoutMs: 30_000 });

    // The scoring computer's sandbox uid for contender code ($AB_RUN, as packages/bench gate.ts).
    const sb = await p.exec(
      scoringId,
      "id -u abrun >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /bin/bash abrun",
      { timeoutMs: 60_000 },
    );
    expect(sb.exitCode, sb.stderr).toBe(0);

    const cases: { label: string; overlay?: string }[] = [
      { label: "tandem-x2" },
      { label: "no-op", overlay: "no-op" },
    ];
    for (const c of cases) {
      const root = `${home}/trials/${c.label}`;
      const trial = await planHarnessStubTrial(kit, "tandem", "toy", {
        root,
        ...(c.overlay ? { overlay: c.overlay } : {}),
        setup: { TANDEM_WORKERS: "2" },
        env: { TANDEM_HOME, PATH: PATH_TDM41 },
      });
      await put(subjectId, root, trial.files);
      await p.exec(subjectId, `chown -R naive:naive ${root}`, { timeoutMs: 30_000 });
      const run = await p.exec(subjectId, `runuser -u naive -- ${trial.command}`, {
        timeoutMs: 400_000,
      });
      const tar = await p.getFile(subjectId, trial.frozenTar);
      const local = path.join(localDir, c.label);
      await mkdir(local, { recursive: true });
      await writeFile(path.join(local, "frozen.tar"), tar);
      const x = spawnSync("tar", ["-xf", "frozen.tar"], { cwd: local, encoding: "utf8" });
      expect(x.status, x.stderr).toBe(0);
      const collected = await collectHarness(local);

      // Scoring computer: gates/hidden-tests/ plus the frozen tar; contender code runs as abrun.
      const sroot = `${home}/score/${c.label}`;
      const gate = await planCliStubGate(kit, "hidden-tests", "toy", { root: sroot });
      await put(scoringId, sroot, gate.files);
      await p.putFile(scoringId, gate.frozenTar, tar);
      const check = await p.exec(
        scoringId,
        [
          "set -e",
          `R=${sroot}`,
          'rm -rf "$R/frozen" "$R/run" "$R/verdict" && mkdir -p "$R/frozen" "$R/run" "$R/verdict"',
          'tar -C "$R/frozen" -xf "$R/frozen.tar"',
          'cp -R "$R/frozen/." "$R/run/" && chown -R abrun:abrun "$R/run"',
          `printf '#!/bin/sh\\nexec runuser -u abrun -- "$@"\\n' > "$R/ab-run" && chmod 755 "$R/ab-run"`,
          `chmod o+x ${home} ${home}/score && chmod 755 "$R"`,
          `AB_RUN="$R/ab-run" AB_RUN_DIR="$R/run" bash "$R/kit/gates/hidden-tests/check.sh" "$R/frozen" toy "$R/verdict/gate.json"`,
        ].join("\n"),
        { timeoutMs: 120_000 },
      );
      expect(check.exitCode, `gate ${c.label}: ${check.stderr}`).toBe(0);
      const verdict = parseGateResult(
        new TextDecoder().decode(await p.getFile(scoringId, `${sroot}/verdict/gate.json`)),
      );
      const runJson = await readFile(path.join(local, "tandem/run.json"), "utf8")
        .then((t) => JSON.parse(t) as Record<string, unknown>)
        .catch(() => null);
      const ls = spawnSync("find", [".", "-type", "f"], {
        cwd: path.join(local, "workspace"),
        encoding: "utf8",
      });
      outcomes.set(c.label, {
        label: c.label,
        runExit: run.exitCode,
        runStderr: run.stderr,
        gate: verdict,
        collected,
        run: runJson,
        workspace: ls.stdout.trim().split("\n").filter(Boolean).sort(),
      });
    }
    if (process.env.TDM41_DOCKER_LOG) {
      await writeFile(
        process.env.TDM41_DOCKER_LOG,
        JSON.stringify(
          [...outcomes.values()].map((o) => ({
            label: o.label,
            runExit: o.runExit,
            run: o.run,
            gate: o.gate,
            board: o.collected.board,
            board_source: o.collected.board_source,
            rows: o.collected.rows.map((r) => ({
              name: r.name,
              value: String(r.value),
              collector: r.collector,
              ...(r.labels ? { labels: r.labels } : {}),
            })),
            missing: o.collected.missing,
            workspace: o.workspace,
          })),
          null,
          2,
        ),
      );
    }
  }, 1_500_000);

  afterAll(async () => {
    await Promise.all([subjectId, scoringId].filter(Boolean).map((id) => p.destroy(id)));
    await p.dispose();
    if (localDir) await rm(localDir, { recursive: true, force: true });
    const left = spawnSync(
      "docker",
      ["ps", "-a", "-q", "--filter", `label=${NS_LABEL_TDM41}=${ns}`],
      {
        encoding: "utf8",
      },
    ).stdout.trim();
    if (left) spawnSync("docker", ["rm", "-f", "-v", ...left.split("\n")]);
    expect(left, "the suite leaked containers").toBe("");
  }, 120_000);

  const row = (o: OutcomeTdm41, name: string, labels?: Record<string, string>) =>
    o.collected.rows.find(
      (r) => r.name === name && JSON.stringify(r.labels) === JSON.stringify(labels),
    )?.value;

  it("the Tandem ×2 trial completes and the hidden tests pass on the scoring computer", () => {
    const o = outcomes.get("tandem-x2")!;
    expect(o.runExit, o.runStderr).toBe(0);
    expect(o.run).toMatchObject({
      outcome: "completed",
      workers: 2,
      policy: "auto",
      tandem_version: "0.2.0",
    });
    expect(o.gate).toMatchObject({ pass: true });
  });

  it("extracts the board, the server counters and the sessions' spend", () => {
    const o = outcomes.get("tandem-x2")!;
    expect(o.collected.board_source).toBe("tandem.db");
    expect(o.collected.missing).toEqual([]);
    expect(o.collected.board).toMatchObject({
      epics: 1,
      tickets: 2,
      tickets_by_state: { done: 2 },
    });
    expect(o.collected.board!.claims).toBeGreaterThanOrEqual(2);
    // The epic is approved by the simulated human; its tickets are born approved under `auto`.
    expect(o.collected.board!.approvals_by.human).toBe(1);
    expect(row(o, "tandem_api_claims")).toBe(o.collected.board!.claims);
    expect(row(o, "tandem_api_claim_conflicts")).toBe(o.collected.board!.claim_conflicts);
    // One planner and two workers, each ending with its own result line (0.0125 USD each).
    expect(o.collected.sessions.map((s) => s.name)).toEqual(["planner", "worker-1", "worker-2"]);
    expect(row(o, "cost_micro_usd")).toBe(37_500n);
    // Approvals Anybench records are simulated: counted from approvals.jsonl, not the board.
    expect(row(o, "simulated_approvals")).toBe(1);
    expect(typeof row(o, "simulated_approval_latency_p95_ms")).toBe("number");
    expect(row(o, "harness_outcome", { outcome: "completed" })).toBe(1);
  });

  it("freezes a scrubbed workspace: the work, no harness identity", () => {
    const o = outcomes.get("tandem-x2")!;
    expect(o.workspace).toEqual([
      "./FAKE_PLAN.json",
      "./README.md",
      "./package.json",
      "./src/add.ts",
      "./src/mul.ts",
    ]);
  });

  it("the no-op harness fails the gate and shows 0 claims", () => {
    const o = outcomes.get("no-op")!;
    expect(o.runExit).toBe(0);
    expect(o.gate.pass).toBe(false);
    expect(o.collected.board).toBeNull();
    expect(row(o, "tandem_claims")).toBeUndefined();
  });
});
