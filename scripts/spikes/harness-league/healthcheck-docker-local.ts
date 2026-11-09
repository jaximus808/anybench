// TDM-227 [21.1]: install kits/harness-league contenders the way the env build does, run their
// health checks, and optionally a 1-turn smoke through each one's real driver, in one docker-local
// node:22 computer. Mirrors packages/envs build.ts: subject files (adapters/, workloads/,
// scripts/setup-workspace.sh) staged under ~/kit; each contender's install as root with HOME kept
// and its `versions` as env (deduplicated as apps/server subjectPlan does), the home chowned back,
// then its health check as the eval user.
//
//   node --env-file=<repo>/.env --import tsx scripts/spikes/harness-league/healthcheck-docker-local.ts \
//     <contender>[,<contender>...|all] [--smoke <contender>[,...]|--smoke] [--cpus 2] [--out DIR]
//
// `all` installs every contender in kit order into the same image, as the env snapshot does; a
// smoke there shows what each setup really loads next to the others (a skill pack must not leak
// into the baseline). --smoke alone smokes every listed contender. A smoke runs the contender's
// driver once (CC_MAX_TURNS=1) on a one-file workspace with the task "list your skills", on
// ANTHROPIC_API_KEY (never printed: it reaches the container only through stdin into
// ~/.anybench/env, 0600), reads Claude Code's system/init event (skills, plugins, agents, tools)
// and result (cost) from stream.jsonl, and checks no file brought back holds the key. Each smoke
// starts from the post-install image (a fresh `docker commit`), as every trial forks from the
// snapshot. Removes only the containers and the image it created.
//
// TDM-228 [21.2] (headless policy): `--task <instruction.md> --input <dir>` smokes a real, small
// task instead (the workspace starts as a git repo of <dir>), `--turns N` sets CC_MAX_TURNS (0:
// no limit; default 1, and none with --task), `--wall S` the driver's wall cap (default 1200 with
// --task). The report then also has what bench's stream-json collector reads from stream.jsonl
// (processes, questions_auto_answered, turns, cost), each auto-answer event, the workspace's files
// and `npm test` in it.
//
//   node --env-file=.env --import tsx scripts/spikes/harness-league/healthcheck-docker-local.ts \
//     superpowers --smoke --task kits/tandem-vs-claude-code/workloads/todo-api/instruction.md \
//     --input kits/tandem-vs-claude-code/workloads/todo-api/input
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatEnvFile, parseStreamJson } from "../../../packages/bench/src/index.js";
import { safeParseKitSpec } from "../../../packages/core/src/index.js";
import { KIT_LAYOUT, parseKitYaml } from "../../../packages/kit/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const kitDir = path.join(repo, "kits/harness-league");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : undefined;
};
const which = args[0];
if (!which || which.startsWith("--"))
  throw new Error("usage: healthcheck-docker-local.ts <contender>[,...]|all [--smoke [ids]]");
const cpus = flag("--cpus") ?? "2";
const label = which.replace(/,/g, "+");
const outDir = path.resolve(flag("--out") ?? path.join(repo, `.tmp-tdm227-hc/${label}`));
const NAME = `ab-tdm227-hc-${process.pid}`;
const IMAGE = `ab-tdm227-hc-img:${process.pid}`;
const USER = "evaluser";
const HOME = `/home/${USER}`;
const SMOKE_TASK =
  "List the skills, plugins and slash commands you have available in this session, one per line with a few words each. Do not read, create or change any file.";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const docker = (a: string[], input?: string | Buffer) =>
  execFileSync("docker", a, { input, maxBuffer: 1 << 28, encoding: "utf8" });
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const manifest = path.join(kitDir, "anybench.yaml");
const parsed = safeParseKitSpec(parseKitYaml(readFileSync(manifest, "utf8"), manifest).data);
if (!parsed.success) throw new Error(parsed.errors.join("\n"));
const spec = parsed.data;
const ids = which === "all" ? spec.contenders.map((c) => c.id) : which.split(",");
const contenders = ids.map((id) => {
  const c = spec.contenders.find((x) => x.id === id);
  if (!c) throw new Error(`no contender '${id}' in ${manifest}`);
  return c;
});
const smokeIds = !args.includes("--smoke") ? [] : (flag("--smoke")?.split(",") ?? ids);
const taskFile = flag("--task");
const inputDir = flag("--input");
if ((taskFile === undefined) !== (inputDir === undefined))
  throw new Error("--task and --input go together");
const turns = flag("--turns") ?? (taskFile ? "0" : "1");
const wall = flag("--wall") ?? (taskFile ? "1200" : undefined);
const smokeTask = taskFile ? readFileSync(path.resolve(repo, taskFile), "utf8") : SMOKE_TASK;

type Report = Record<string, unknown>;

function smokeOne(id: string, key: string): Report {
  const c = spec.contenders.find((x) => x.id === id)!;
  const driver = c.driver.script ?? KIT_LAYOUT.driverScript(c.id);
  const name = `${NAME}-smoke-${id}`;
  const r: Report = { driver };
  docker(["run", "-d", "--init", "--cpus", cpus, "--name", name, IMAGE, "sleep", "infinity"]);
  try {
    const asUser = (cmd: string, input?: string | Buffer) =>
      docker(["exec", "-i", "-u", USER, "-w", HOME, name, "bash", "-lc", cmd], input);
    asUser("mkdir -p ~/.anybench ~/eval/out ~/eval/ws");
    asUser("umask 077 && cat > ~/.anybench/env", formatEnvFile({ ANTHROPIC_API_KEY: key }));
    asUser("cat > ~/eval/task.md", smokeTask);
    if (inputDir) {
      const input = execFileSync(
        "tar",
        [
          "--no-xattrs",
          "-C",
          path.resolve(repo, inputDir),
          "--exclude",
          ".DS_Store",
          "-cf",
          "-",
          ".",
        ],
        { maxBuffer: 1 << 28, env: { ...process.env, COPYFILE_DISABLE: "1" } },
      );
      asUser("tar -C ~/eval/ws -xf -", input);
    } else asUser("cd ~/eval/ws && printf '# smoke\\n' > README.md");
    asUser(
      "cd ~/eval/ws && git init -q && git add . && " +
        "GIT_AUTHOR_NAME=k GIT_AUTHOR_EMAIL=k@x.invalid GIT_COMMITTER_NAME=k GIT_COMMITTER_EMAIL=k@x.invalid git commit -qm init",
    );
    const env: Record<string, string> = { ...(c.driver.env ?? {}) };
    if (turns !== "0") env.CC_MAX_TURNS = turns;
    if (wall) env.CC_WALL_CAP_S = wall;
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    log(
      `smoke ${id}: ${driver} run (CC_MAX_TURNS=${env.CC_MAX_TURNS ?? "none"}, wall ${env.CC_WALL_CAP_S})`,
    );
    const t1 = Date.now();
    const d = spawnSync(
      "docker",
      [
        "exec",
        "-u",
        USER,
        "-w",
        HOME,
        "-e",
        `EVAL_OUT=${HOME}/eval/out`,
        "-e",
        `EVAL_WS=${HOME}/eval/ws`,
        "-e",
        `EVAL_SECRETS=${HOME}/.anybench/env`,
        ...envArgs,
        name,
        "bash",
        "-lc",
        `bash ~/kit/${driver} run ~/eval/task.md ~/eval/ws`,
      ],
      { encoding: "utf8", maxBuffer: 1 << 28, timeout: (Number(wall ?? 540) + 60) * 1000 },
    );
    r.smoke_s = Math.round((Date.now() - t1) / 1000);
    r.smoke_exit = d.status;
    const dir = path.join(outDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "driver.log"), `${d.stdout}\n--- stderr\n${d.stderr}`);
    const stream = asUser("cat ~/eval/out/stream.jsonl 2>/dev/null || true");
    const stderr = asUser("cat ~/eval/out/claude.stderr.log 2>/dev/null || true");
    const versions = asUser("cat ~/eval/out/versions.json 2>/dev/null || true");
    writeFileSync(path.join(dir, "stream.jsonl"), stream);
    writeFileSync(path.join(dir, "claude.stderr.log"), stderr);
    writeFileSync(path.join(dir, "versions.json"), versions);
    r.key_leaks = [stream, stderr, versions, d.stdout, d.stderr].filter((t) =>
      t.includes(key),
    ).length;
    const summary = parseStreamJson(stream);
    r.collector = {
      processes: summary.processes,
      headless_policy: summary.headless_policy,
      questions_auto_answered: summary.questions_auto_answered,
      auto_answer_cap_reached: summary.auto_answer_cap_reached,
      turns: summary.turns,
      tool_calls: summary.tool_calls,
      cost_micro_usd: summary.cost_micro_usd === null ? null : String(summary.cost_micro_usd),
      result_subtype: summary.result_subtype,
    };
    if (taskFile) {
      r.workspace_files = asUser(
        "cd ~/eval/out/workspace 2>/dev/null && find . -type f -not -path './docs/*' | sort || true",
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      r.workspace_docs = asUser(
        "cd ~/eval/out/workspace 2>/dev/null && find ./docs -type f 2>/dev/null | sort || true",
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      const t = spawnSync(
        "docker",
        [
          "exec",
          "-u",
          USER,
          "-w",
          `${HOME}/eval/out/workspace`,
          name,
          "bash",
          "-lc",
          "npm test 2>&1 | tail -15",
        ],
        { encoding: "utf8" },
      );
      r.npm_test = t.stdout.trim();
    }
    for (const line of stream.split("\n")) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "system" && e.subtype === "init") {
        r.init = {
          model: e.model,
          claude_code_version: e.claude_code_version,
          apiKeySource: e.apiKeySource,
          cwd: e.cwd,
          skills: e.skills,
          plugins: e.plugins,
          slash_commands: e.slash_commands,
          tools: e.tools,
          agents: e.agents,
          mcp_servers: e.mcp_servers,
        };
      }
      if (e.type === "system" && typeof e.subtype === "string" && e.subtype.startsWith("anybench_"))
        r.policy_events = [...((r.policy_events as unknown[] | undefined) ?? []), e];
      if (e.type === "system" && e.subtype === "hook_response")
        r.hooks = [...((r.hooks as string[] | undefined) ?? []), String(e.hook_name)];
      if (e.type === "result") {
        r.results = [
          ...((r.results as unknown[] | undefined) ?? []),
          {
            num_turns: e.num_turns,
            total_cost_usd: e.total_cost_usd,
            text: typeof e.result === "string" ? e.result.slice(-1500) : null,
          },
        ];
        r.result = {
          subtype: e.subtype,
          num_turns: e.num_turns,
          total_cost_usd: e.total_cost_usd,
          text: typeof e.result === "string" ? e.result.slice(0, 4000) : null,
        };
      }
    }
    // The real home's ~/.claude after the trial: a skill pack's driver leaves it untouched.
    r.real_home_claude = asUser("ls -A ~/.claude 2>/dev/null || true")
      .trim()
      .split("\n")
      .filter(Boolean);
    log(`smoke ${id} exited ${d.status} in ${r.smoke_s}s; key leaks ${r.key_leaks}`);
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
  return r;
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const report: Report = { contenders: ids, smokes: {} as Record<string, Report> };
  log(`container ${NAME} (node:22, --init, --cpus ${cpus}), user ${USER}`);
  docker(["run", "-d", "--init", "--cpus", cpus, "--name", NAME, "node:22", "sleep", "infinity"]);
  let committed = false;
  try {
    docker(["exec", NAME, "useradd", "-m", "-d", HOME, USER]);
    const asUser = (cmd: string, input?: string | Buffer) =>
      docker(["exec", "-i", "-u", USER, "-w", HOME, NAME, "bash", "-lc", cmd], input);
    // Subject files only, as the env build stages them (never gates/ or proof/).
    const tar = execFileSync(
      "tar",
      [
        "--no-xattrs",
        "-C",
        kitDir,
        "--exclude",
        ".DS_Store",
        "-cf",
        "-",
        "adapters",
        "workloads",
        "scripts/setup-workspace.sh",
      ],
      { maxBuffer: 1 << 28, env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    asUser("mkdir -p ~/kit && tar -C ~/kit -xf -", tar);

    const installs: Report[] = [];
    const seen = new Set<string>();
    for (const c of contenders) {
      const install = c.install.script ?? KIT_LAYOUT.installScript(c.id);
      const healthcheck = c.install.healthcheck ?? KIT_LAYOUT.healthcheckScript(c.id);
      const key = JSON.stringify([install, healthcheck, c.versions ?? {}]);
      if (seen.has(key)) continue;
      seen.add(key);
      const versionsEnv = Object.entries(c.versions ?? {})
        .map(([k, v]) => `${k}=${sh(v)}`)
        .join(" ");
      const run = (script: string) =>
        `cd ${HOME}/kit/${path.posix.dirname(script)} && ${versionsEnv} bash ${HOME}/kit/${script}`;
      const row: Report = { contender: c.id, install, healthcheck };
      installs.push(row);
      log(`install ${c.id} (root, HOME=${HOME}): ${install} with ${versionsEnv}`);
      const t0 = Date.now();
      const ins = spawnSync(
        "docker",
        [
          "exec",
          "-e",
          `HOME=${HOME}`,
          NAME,
          "bash",
          "-c",
          `${run(install)} && chown -R ${USER}:${USER} ${HOME}`,
        ],
        { encoding: "utf8", maxBuffer: 1 << 28 },
      );
      row.install_s = Math.round((Date.now() - t0) / 1000);
      row.install_exit = ins.status;
      writeFileSync(
        path.join(outDir, `install-${c.id}.log`),
        `${ins.stdout}\n--- stderr\n${ins.stderr}`,
      );
      log(`install ${c.id} exited ${ins.status} in ${row.install_s}s`);
      if (ins.status !== 0) {
        log((ins.stdout + ins.stderr).trim().split("\n").slice(-20).join("\n"));
        throw new Error(`install ${c.id} failed`);
      }
      const hc = spawnSync(
        "docker",
        ["exec", "-u", USER, "-w", HOME, NAME, "bash", "-lc", run(healthcheck)],
        { encoding: "utf8" },
      );
      row.healthcheck_exit = hc.status;
      row.healthcheck_out = (hc.stdout + hc.stderr).trim();
      writeFileSync(
        path.join(outDir, `healthcheck-${c.id}.log`),
        `${hc.stdout}\n--- stderr\n${hc.stderr}`,
      );
      log(
        `healthcheck ${c.id} (as ${USER}): ${healthcheck} exited ${hc.status}: ${row.healthcheck_out}`,
      );
      if (hc.status !== 0) throw new Error(`healthcheck ${c.id} failed`);
    }
    report.installs = installs;

    if (smokeIds.length > 0) {
      const key = process.env.ANTHROPIC_API_KEY ?? "";
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set (run with --env-file=.env)");
      docker(["commit", NAME, IMAGE]);
      committed = true;
      for (const id of smokeIds) (report.smokes as Record<string, Report>)[id] = smokeOne(id, key);
    }
  } finally {
    writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    log(`report: ${path.join(outDir, "report.json")}`);
    spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
    if (committed) spawnSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });
  }
}

main();
