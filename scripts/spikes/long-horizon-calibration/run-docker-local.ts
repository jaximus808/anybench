// TDM-239 [18.18]: one docker-local calibration trial of kits/tandem-long-horizon on real
// Anthropic tokens: either setup (claude-code-solo or tandem), either rung (project-tracker or
// project-tracker-xl). The TDM-212 smoke (scripts/spikes/long-horizon-smoke) with three changes:
// the Tandem install (Claude Code as root, install-tandem.sh as the eval user, the contender's own
// healthcheck), a --workload flag, and the trial and gate containers pinned with --cpuset-cpus
// (default 0-1: the founder's Mac runs one trial at a time on 2 CPUs). The exact TrialJob the
// worker builds (apps/server preparedJob), the real in-VM runner (bun binary), then the
// hidden-tests gate in a fresh container with no network.
//
//   node --env-file=<repo>/.env --import tsx scripts/spikes/long-horizon-calibration/run-docker-local.ts \
//     --contender claude-code-solo|tandem --workload project-tracker|project-tracker-xl \
//     [--cap-micro-usd 25000000] [--cpuset 0-1] [--out DIR]
//
// Needs: docker (node:22 image), packages/runner/dist/bin/runner-linux-<arch> (pnpm --filter
// @anybench/runner build:bin), ANTHROPIC_API_KEY in the env (never printed: it reaches the
// container only through stdin into ~/.anybench/env, 0600). The spend cap is the runner's own BYOK
// cap (default: the kit's token_cap_micro_usd), so the trial stops itself on overrun. Writes
// summary.json; analyze.ts turns the out dir into the calibration row. Removes only the
// containers it created.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Relative imports: the repo root has no workspace deps (as scripts/ops imports apps/server/src).
import { formatEnvFile } from "../../../packages/bench/src/index.js";
import { safeParseKitSpec } from "../../../packages/core/src/index.js";
import { parseKitYaml } from "../../../packages/kit/src/index.js";
import { TRIAL_JOB_VERSION } from "../../../packages/runner/src/index.js";
import { preparedJob } from "../../../apps/server/src/orchestrator/trial-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const kitDir = path.join(repo, "kits/tandem-long-horizon");
const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const contender = flag("--contender", "claude-code-solo");
const workload = flag("--workload", "project-tracker");
const cpuset = flag("--cpuset", "0-1");
const TRIAL_ID = `tdm239-${contender}-${workload}`;
const NAME = `ab-tdm239-${contender}-${process.pid}`;
const outDir = path.resolve(
  flag("--out", path.join(repo, ".tmp-tdm239", `${contender}-${workload}`)),
);
const GATE_NAME = `${NAME}-gate`;
const USER = "evaluser";
const HOME = `/home/${USER}`;
const POLL_MS = 30_000;

const key = process.env.ANTHROPIC_API_KEY ?? "";
if (!key) throw new Error("ANTHROPIC_API_KEY is not set (run with --env-file=.env)");

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const docker = (a: string[], input?: string | Buffer) =>
  execFileSync("docker", a, { input, maxBuffer: 1 << 28, encoding: "utf8" });
const asUser = (cmd: string, input?: string | Buffer) =>
  docker(["exec", "-i", "-u", USER, "-w", HOME, NAME, "bash", "-lc", cmd], input);

// The job the worker would send (env image: kit at ~/kit), plus the smoke's identity and cap.
const manifest = path.join(kitDir, "anybench.yaml");
const parsed = safeParseKitSpec(parseKitYaml(readFileSync(manifest, "utf8"), manifest).data);
if (!parsed.success) throw new Error(parsed.errors.join("\n"));
const spec = parsed.data;
const kitContender = spec.contenders.find((c) => c.id === contender);
if (!kitContender) throw new Error(`no contender '${contender}' in the kit`);
if (!spec.workloads.some((w) => w.id === workload)) throw new Error(`no workload '${workload}'`);
const kitCap = (kitContender.driver as { token_cap_micro_usd?: number }).token_cap_micro_usd;
const capMicroUsd = BigInt(flag("--cap-micro-usd", String(kitCap ?? 25_000_000)));
const ccVersion = kitContender.versions?.CLAUDE_CODE_VERSION ?? "2.1.319";
const prepared = preparedJob(spec, contender, workload, {
  env: {},
  path: [],
  kit_dir: "kit",
});
const job = {
  ...prepared,
  version: TRIAL_JOB_VERSION,
  trial_id: TRIAL_ID,
  run_id: "tdm239",
  attempt: 1,
  ingest: null,
  upload: { ...prepared.upload, enabled: false },
  token_cap_micro_usd: capMicroUsd.toString(),
  ...(prepared.token_prices
    ? {
        token_prices: Object.fromEntries(
          Object.entries(prepared.token_prices).map(([k, v]) => [k, String(v)]),
        ),
      }
    : {}),
};

function tarOf(dir: string, exclude: string[]): Buffer {
  return execFileSync(
    "tar",
    ["-C", dir, ...exclude.flatMap((e) => ["--exclude", e]), "-cf", "-", "."],
    { maxBuffer: 1 << 28, env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const bin = path.join(
    repo,
    `packages/runner/dist/bin/runner-linux-${arch() === "arm64" ? "arm64" : "x64"}`,
  );
  if (!existsSync(bin))
    throw new Error(`${bin} is missing: pnpm --filter @anybench/runner build:bin`);

  log(`container ${NAME} (node:22, --init, cpuset ${cpuset}), user ${USER}`);
  docker([
    "run",
    "-d",
    "--init",
    "--cpuset-cpus",
    cpuset,
    "--name",
    NAME,
    "node:22",
    "sleep",
    "infinity",
  ]);
  try {
    docker(["exec", NAME, "useradd", "-m", "-d", HOME, USER]);
    // The contender's install.sh, split by who runs it: Claude Code goes in globally (root), and
    // Tandem's server and gateway under the eval user's ~/.anybench/tandem, where run.sh looks.
    log(`install: Claude Code ${ccVersion} (root)`);
    docker(["exec", NAME, "npm", "install", "-g", `@anthropic-ai/claude-code@${ccVersion}`]);
    // Subject files only (as the env build copies them): never gates/ or proof/.
    asUser("mkdir -p ~/kit ~/.anybench/bin ~/eval");
    asUser("tar -C ~/kit -xf -", tarOf(kitDir, ["./gates", "./proof", "./.DS_Store"]));
    if (contender === "tandem") {
      log("install: kit/adapters/tandem/install-tandem.sh (eval user)");
      asUser("bash kit/adapters/tandem/install-tandem.sh");
    }
    asUser("cat > ~/.anybench/bin/runner && chmod 755 ~/.anybench/bin/runner", readFileSync(bin));
    const health = kitContender.install?.healthcheck ?? "adapters/claude-code/healthcheck.sh";
    asUser(`bash kit/${health} && claude --version && node --version`);
    asUser("umask 077 && cat > ~/.anybench/env", formatEnvFile({ ANTHROPIC_API_KEY: key }));
    asUser("cat > ~/.anybench/trial.json", JSON.stringify(job, null, 2));
    writeFileSync(path.join(outDir, "trial.json"), `${JSON.stringify(job, null, 2)}\n`);

    const started = Date.now();
    log(`launch runner (wall cap ${job.wall_clock_s}s, spend cap ${capMicroUsd} micro-USD)`);
    asUser(`setsid nohup ~/.anybench/bin/runner --trial ${TRIAL_ID} >> ~/eval/runner.log 2>&1 &`);
    let phase = "";
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let s: { phase?: string; token_cap?: Record<string, unknown> } = {};
      try {
        s = JSON.parse(asUser("cat ~/eval/out/status.json 2>/dev/null || echo '{}'"));
      } catch {
        /* mid-write */
      }
      phase = s.phase ?? phase;
      log(
        `phase ${phase || "?"} · ${Math.round((Date.now() - started) / 1000)}s · spend ${JSON.stringify(s.token_cap ?? null)}`,
      );
      if (["done", "failed", "failed_subject", "failed_infra", "cancelled"].includes(phase)) break;
      if (phase === "" && Date.now() - started > 600_000)
        throw new Error("runner never wrote status.json");
    }
    const wallS = Math.round((Date.now() - started) / 1000);

    // Bring the outputs home. A run stopped by a cap never froze its workspace: freeze ~/eval/ws.
    const local = path.join(outDir, "out");
    spawnSync("rm", ["-rf", local]);
    mkdirSync(local, { recursive: true });
    execFileSync("tar", ["-C", local, "-xf", "-"], {
      input: Buffer.from(
        execFileSync(
          "docker",
          ["exec", "-u", USER, NAME, "tar", "-C", `${HOME}/eval/out`, "-cf", "-", "."],
          {
            maxBuffer: 1 << 29,
          },
        ),
      ),
      maxBuffer: 1 << 29,
    });
    writeFileSync(path.join(outDir, "runner.log"), asUser("cat ~/eval/runner.log"));
    let frozenBy = "driver";
    if (!existsSync(path.join(local, "workspace"))) {
      frozenBy = "smoke script (~/eval/ws: the runner stopped the driver before it froze)";
      mkdirSync(path.join(local, "workspace"));
      execFileSync("tar", ["-C", path.join(local, "workspace"), "-xf", "-"], {
        input: Buffer.from(
          execFileSync(
            "docker",
            [
              "exec",
              "-u",
              USER,
              NAME,
              "tar",
              "-C",
              `${HOME}/eval/ws`,
              "--exclude=.git",
              "--exclude=node_modules",
              "-cf",
              "-",
              ".",
            ],
            { maxBuffer: 1 << 29 },
          ),
        ),
      });
    }

    // The gate, offline, in a fresh container (contender code never runs on the host).
    log("gate hidden-tests (fresh node:22, --network none)");
    const gateOut = path.join(outDir, "gate");
    spawnSync("rm", ["-rf", gateOut]);
    mkdirSync(path.join(gateOut, "frozen"), { recursive: true });
    mkdirSync(path.join(gateOut, "run"), { recursive: true });
    execFileSync("cp", ["-R", `${local}/.`, path.join(gateOut, "frozen")]);
    execFileSync("cp", [
      "-R",
      path.join(local, "workspace"),
      path.join(gateOut, "run", "workspace"),
    ]);
    const g = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        GATE_NAME,
        "--network",
        "none",
        "--cpuset-cpus",
        cpuset,
        "-v",
        `${kitDir}:/kit:ro`,
        "-v",
        `${gateOut}:/g`,
        "-e",
        "AB_RUN=/kit/scripts/ab-run-local.sh",
        "-e",
        "AB_RUN_DIR=/g/run",
        "node:22",
        "bash",
        "/kit/gates/hidden-tests/check.sh",
        "/g/frozen",
        workload,
        "/g/gate.json",
      ],
      { encoding: "utf8", maxBuffer: 1 << 26, timeout: 1_900_000 },
    );
    writeFileSync(path.join(outDir, "gate.log"), `${g.stdout}\n${g.stderr}`);
    const gate = existsSync(path.join(gateOut, "gate.json"))
      ? JSON.parse(readFileSync(path.join(gateOut, "gate.json"), "utf8"))
      : null;
    const metricsFile = path.join(gateOut, "frozen", "hidden-tests.metrics.jsonl");
    const metrics = existsSync(metricsFile) ? readFileSync(metricsFile, "utf8").trim() : null;

    // Spend and tokens from the transcript (Claude Code's own result line, and per-message usage).
    const stream = path.join(local, "stream.jsonl");
    const usage = new Map<string, number[]>();
    let reported: string | null = null;
    let turns: number | null = null;
    // The session's real totals. Per-message stream usage carries each message's output count
    // from its start (finding 2 in docs/findings/long-horizon-kit.md), so it undercounts output.
    let resultUsage: Record<string, number> | null = null;
    if (existsSync(stream)) {
      for (const line of readFileSync(stream, "utf8").split("\n")) {
        let e: {
          type?: string;
          message?: { id?: string; usage?: Record<string, number> };
          total_cost_usd?: number;
          num_turns?: number;
          usage?: Record<string, number>;
        };
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "assistant" && e.message?.usage) {
          const u = e.message.usage;
          const t = [
            u.input_tokens ?? 0,
            u.output_tokens ?? 0,
            u.cache_read_input_tokens ?? 0,
            u.cache_creation_input_tokens ?? 0,
          ];
          const prev = usage.get(e.message.id ?? `anon${usage.size}`);
          usage.set(
            e.message.id ?? `anon${usage.size}`,
            prev ? prev.map((x, i) => Math.max(x, t[i]!)) : t,
          );
        }
        if (e.type === "result") {
          reported = /"total_cost_usd"\s*:\s*([0-9.eE+-]+)/.exec(line)?.[1] ?? null;
          turns = e.num_turns ?? null;
          resultUsage = e.usage ?? null;
        }
      }
    }
    const tokens = [...usage.values()].reduce((a, t) => a.map((x, i) => x + t[i]!), [0, 0, 0, 0]);
    const status = JSON.parse(readFileSync(path.join(local, "status.json"), "utf8"));

    // No key anywhere in what came back.
    const leaks: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (readFileSync(p).includes(key)) leaks.push(path.relative(outDir, p));
      }
    };
    walk(outDir);

    const summary = {
      contender,
      workload,
      wall_s: wallS,
      runner: {
        phase: status.phase,
        result: status.result ?? null,
        token_cap: status.token_cap ?? null,
      },
      workspace_frozen_by: frozenBy,
      gate,
      gate_metrics: metrics,
      tokens: resultUsage
        ? {
            input: resultUsage.input_tokens,
            output: resultUsage.output_tokens,
            cache_read: resultUsage.cache_read_input_tokens,
            cache_creation: resultUsage.cache_creation_input_tokens,
            messages: usage.size,
          }
        : null,
      stream_message_usage_sum: {
        input: tokens[0],
        output: tokens[1],
        cache_read: tokens[2],
        cache_creation: tokens[3],
      },
      claude_code_total_cost_usd: reported,
      num_turns: turns,
      key_leaks: leaks,
    };
    writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
    spawnSync("docker", ["rm", "-f", GATE_NAME], { stdio: "ignore" });
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
