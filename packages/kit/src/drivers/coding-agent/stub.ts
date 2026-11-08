// TDM-39 [4.7]: a runner stub for coding-agent kits: what goes on the subject computer, what goes
// on the scoring computer, and the bash each one runs. Used by the example's proof and the tests
// until the trial executor drives the real runner; it follows the same contracts:
//   - runner (TDM-46): verbs run from the kit root with EVAL_IN / EVAL_WS / EVAL_OUT /
//     EVAL_SECRETS set and `{task}`, `{workspace}`, `{in}`, `{out}` substituted; the workload's
//     setup.sh builds EVAL_WS first; EVAL_OUT is frozen into one tar afterwards;
//   - gate runner (TDM-51): `check.sh <frozen-out> <workload> <gate.json>` with `$AB_RUN` and
//     `$AB_RUN_DIR` (here a pass-through, since the stub has no second uid to switch to).
// The two computers are kept apart (plan.md 17.2 rule 5):
//   - the subject computer gets `adapters/`, `workloads/<id>/` and, under an overlay, that
//     overlay's own dir and driver: never gates/ or reference/, and proof/oracle/ only for the
//     oracle overlay, which runs no agent;
//   - the scoring computer gets only `gates/<gate>/`, the gate's reference and the frozen tar.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { driverTokenCapTokens, type ProofOverlay } from "@anybench/core";
import { canonicalKitPath, hashKitPaths } from "../../hash.js";
import { KIT_LAYOUT, normalizeKitPath } from "../../layout.js";
import type { LoadedKit } from "../../validate.js";
import { CLI_SCRIPT_SHEBANG, shQuote } from "../cli/shell.js";
import type { CliStubFile } from "../cli/stub.js";

export class CodingAgentStubError extends Error {
  override readonly name = "CodingAgentStubError";
}

export interface CodingAgentStubPlan {
  files: CliStubFile[];
  /** The bash to run on the computer (also among `files`). */
  script: string;
  command: string;
}

export interface CodingAgentStubTrialPlan extends CodingAgentStubPlan {
  contenderId: string;
  workloadId: string;
  overlayId: string | null;
  workloadSha256: string;
  /** Where the frozen EVAL_OUT tar lands, absolute on the computer. */
  frozenTar: string;
  /** Exit status of the `run` verb, absolute on the computer. */
  runExitFile: string;
}

export interface CodingAgentStubGatePlan extends CodingAgentStubPlan {
  gateId: string;
  workloadId: string;
  /** Put the trial's frozen tar here before running `command`, absolute. */
  frozenTar: string;
  /** Where check.sh writes its verdict, absolute. */
  gateJson: string;
}

export interface PlanCodingAgentStubTrialOptions {
  /** Absolute trial root on the subject computer. */
  root: string;
  /** A proof overlay id (oracle, do_less[], regression) applied to the contender. */
  overlay?: string;
  /** Extra non-secret env (ANYBENCH_EVAL_USER, ANYBENCH_EVAL_HOME, PATH for a fake claude, ...). */
  env?: Readonly<Record<string, string>>;
  /** Secret values, written to `<root>/secrets.env` (0600), never into the script. */
  secrets?: Readonly<Record<string, string>>;
  /**
   * The Naïve proxy env the worker writes per trial (`claudeCodeProxyEnv` in @anybench/naive),
   * written to `<root>/proxy.env` (0600) and named by ANYBENCH_PROXY_ENV_FILE.
   */
  proxyEnv?: Readonly<Record<string, string>>;
  /** Driver types this stub runs. Default `coding-agent` (the harness driver can reuse it). */
  driverTypes?: readonly string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function rootOf(root: string): string {
  if (!root.startsWith("/") || root.includes("'") || /\s/.test(root)) {
    throw new CodingAgentStubError(
      `computer root must be an absolute path without spaces or quotes: ${root}`,
    );
  }
  return root.replace(/\/+$/, "");
}

const underDir = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

interface Sourced extends CliStubFile {
  kitPath: string;
}

async function kitFiles(kit: LoadedKit, rel: string, toPrefix: string): Promise<Sourced[]> {
  const { hash, problems } = await hashKitPaths(kit.dir, [rel]);
  if (problems.length > 0) {
    throw new CodingAgentStubError(
      `cannot ship ${rel}: ${problems.map((p) => `${p.path} (${p.kind})`).join(", ")}`,
    );
  }
  const base = normalizeKitPath(rel);
  return Promise.all(
    hash.files.map(async (f) => ({
      kitPath: f.path,
      to: path.posix.join(toPrefix, f.path.slice(base.length).replace(/^\//, "")),
      content: new Uint8Array(await readFile(path.join(kit.dir, f.path))),
      mode: f.path.endsWith(".sh") ? 0o755 : 0o644,
    })),
  );
}

const text = (to: string, s: string, mode = 0o644): CliStubFile => ({
  to,
  content: new TextEncoder().encode(s),
  mode,
});

function findOverlay(kit: LoadedKit, id: string): { overlay: ProofOverlay; oracle: boolean } {
  const { oracle, do_less, regression } = kit.spec.proof;
  if (oracle?.id === id) return { overlay: oracle, oracle: true };
  const o = [...do_less, regression].find((x) => x?.id === id);
  if (!o) throw new CodingAgentStubError(`no proof overlay '${id}' in the kit`);
  return { overlay: o, oracle: false };
}

/**
 * Throws unless every file bound for the subject computer is allowed there: nothing from gates/
 * or reference/, and nothing from proof/oracle/ unless `oracleRun` (the oracle overlay runs the
 * reference solution, not an agent).
 */
export function assertCodingAgentSubjectFiles(
  files: readonly { kitPath: string }[],
  oracleRun: boolean,
): void {
  for (const f of files) {
    for (const dir of [KIT_LAYOUT.gatesDir, KIT_LAYOUT.referenceDir]) {
      if (underDir(f.kitPath, dir)) {
        throw new CodingAgentStubError(
          `refusing to ship ${f.kitPath} to the subject computer: ${dir}/ never reaches it`,
        );
      }
    }
    if (!oracleRun && underDir(f.kitPath, KIT_LAYOUT.proofOracleDir)) {
      throw new CodingAgentStubError(
        `refusing to ship ${f.kitPath} to the subject computer: the oracle only ships for the oracle run`,
      );
    }
  }
}

/** Plan one coding-agent trial of `contender` on `workload`, optionally under a proof overlay. */
export async function planCodingAgentStubTrial(
  kit: LoadedKit,
  contenderId: string,
  workloadId: string,
  opts: PlanCodingAgentStubTrialOptions,
): Promise<CodingAgentStubTrialPlan> {
  const root = rootOf(opts.root);
  const spec = kit.spec.contenders.find((c) => c.id === contenderId);
  const resolved = kit.contenders.find((c) => c.id === contenderId);
  if (!spec || !resolved)
    throw new CodingAgentStubError(`no contender '${contenderId}' in the kit`);
  const types = opts.driverTypes ?? ["coding-agent"];
  if (!types.includes(spec.driver.type)) {
    throw new CodingAgentStubError(
      `contender '${contenderId}' has driver.type ${spec.driver.type}, not ${types.join(" or ")}`,
    );
  }
  const workload = kit.spec.workloads.find((w) => w.id === workloadId);
  const digest = kit.workloads.find((w) => w.id === workloadId);
  if (!workload || !digest)
    throw new CodingAgentStubError(`no workload '${workloadId}' in the kit`);

  const driverPath = canonicalKitPath(resolved.driver);
  if (driverPath === undefined || !underDir(driverPath, KIT_LAYOUT.adaptersDir)) {
    throw new CodingAgentStubError(
      `contender '${contenderId}': the driver must live under adapters/, not ${resolved.driver}`,
    );
  }
  const files: Sourced[] = await kitFiles(
    kit,
    KIT_LAYOUT.adaptersDir,
    `kit/${KIT_LAYOUT.adaptersDir}`,
  );

  const found = opts.overlay === undefined ? undefined : findOverlay(kit, opts.overlay);
  const overlay = found?.overlay;
  if (overlay?.contender !== undefined && overlay.contender !== contenderId) {
    throw new CodingAgentStubError(
      `overlay '${overlay.id}' applies to contender '${overlay.contender}', not '${contenderId}'`,
    );
  }
  if (overlay !== undefined) {
    const dir = normalizeKitPath(overlay.dir);
    files.push(...(await kitFiles(kit, dir, `kit/${dir}`)));
    if (overlay.driver_patch !== undefined) {
      const patch = canonicalKitPath(overlay.driver_patch);
      if (patch === undefined || !patch.endsWith(".sh")) {
        throw new CodingAgentStubError(
          `overlay '${overlay.id}': driver_patch must be a replacement driver .sh, not ${overlay.driver_patch}`,
        );
      }
      const [patched, ...rest] = await kitFiles(kit, patch, `kit/${driverPath}`);
      if (patched === undefined || rest.length > 0) {
        throw new CodingAgentStubError(`overlay '${overlay.id}': driver_patch must be one file`);
      }
      const i = files.findIndex((f) => f.to === `kit/${driverPath}`);
      const replacement = { ...patched, to: `kit/${driverPath}`, mode: 0o755 };
      if (i >= 0) files[i] = replacement;
      else files.push(replacement);
    }
  }
  if (!files.some((f) => f.to === `kit/${driverPath}`)) {
    throw new CodingAgentStubError(`driver ${driverPath} is not in the kit`);
  }

  const workloadDir = KIT_LAYOUT.workloadDir(workloadId);
  files.push(...(await kitFiles(kit, workloadDir, `kit/${workloadDir}`)));
  const input = normalizeKitPath(workload.input ?? KIT_LAYOUT.workloadInput(workloadId));
  if (!underDir(input, workloadDir)) files.push(...(await kitFiles(kit, input, `kit/${input}`)));
  const instruction = normalizeKitPath(
    workload.instruction ?? KIT_LAYOUT.workloadInstruction(workloadId),
  );
  if (!files.some((f) => f.kitPath === instruction)) {
    throw new CodingAgentStubError(`workload '${workloadId}' has no instruction at ${instruction}`);
  }
  if (
    instruction.startsWith(`${KIT_LAYOUT.proofDir}/`) ||
    !underDir(instruction, KIT_LAYOUT.workloadsDir)
  ) {
    throw new CodingAgentStubError(
      `workload '${workloadId}': the instruction must live under workloads/`,
    );
  }
  const setup = workload.setup === undefined ? undefined : normalizeKitPath(workload.setup);
  if (setup !== undefined && !files.some((f) => f.kitPath === setup)) {
    throw new CodingAgentStubError(
      `workload '${workloadId}': setup ${setup} must live under ${workloadDir}/ (it is all the subject computer gets)`,
    );
  }

  assertCodingAgentSubjectFiles(files, found?.oracle === true);

  const env: Record<string, string> = { ...opts.env, ...spec.versions };
  if (spec.driver.type === "coding-agent" || spec.driver.type === "harness") {
    if (spec.driver.model !== undefined) env.ANYBENCH_MODEL = spec.driver.model;
    if (spec.driver.max_turns !== undefined) env.ANYBENCH_MAX_TURNS = String(spec.driver.max_turns);
    const tokens = driverTokenCapTokens(spec.driver);
    if (tokens !== undefined) env.ANYBENCH_TOKEN_CAP_TOKENS = String(tokens);
  }
  Object.assign(env, spec.driver.env, overlay?.env);
  for (const k of Object.keys(env)) {
    if (!ENV_NAME.test(k)) throw new CodingAgentStubError(`bad env name: ${k}`);
  }
  const secrets = Object.entries(opts.secrets ?? {});
  const proxyEnv = Object.entries(opts.proxyEnv ?? {});
  for (const [k, v] of [...secrets, ...proxyEnv]) {
    if (!ENV_NAME.test(k) || /[\n\0']/.test(v)) throw new CodingAgentStubError(`bad secret ${k}`);
  }
  if (proxyEnv.length > 0) env.ANYBENCH_PROXY_ENV_FILE = `${root}/proxy.env`;

  const paths = {
    in: `${root}/kit/${input}`,
    out: `${root}/out`,
    workspace: `${root}/ws`,
    task: `${root}/kit/${instruction}`,
  };
  const sub = (cmd: string) =>
    cmd.replace(/\{(in|out|workspace|task)\}/g, (_m, k: keyof typeof paths) => shQuote(paths[k]));
  const v = spec.driver.verbs;
  const step = (name: string, cmd: string | undefined): string[] =>
    cmd === undefined ? [] : [`echo "[stub] ${name}" >&2`, `bash -c ${shQuote(sub(cmd))}`];
  const frozenTar = `${root}/frozen.tar`;
  const runExitFile = `${root}/run.exit`;
  const script = [
    CLI_SCRIPT_SHEBANG,
    `# anybench coding-agent runner stub (TDM-39): contender ${contenderId}, workload ${workloadId}${overlay ? `, overlay ${overlay.id}` : ""}.`,
    "set -euo pipefail",
    `root=${shQuote(root)}`,
    `export EVAL_IN=${shQuote(paths.in)} EVAL_WS=${shQuote(paths.workspace)} EVAL_OUT=${shQuote(paths.out)}`,
    `export EVAL_SECRETS=${shQuote(`${root}/secrets.env`)} EVAL_PHASE=run WORKLOAD=${shQuote(workloadId)} EVAL_WORKLOAD=${shQuote(workloadId)}`,
    ...Object.entries(env).map(([k, val]) => `export ${k}=${shQuote(val)}`),
    'rm -rf "$EVAL_OUT" "$EVAL_WS" "$root/frozen.tar" "$root/run.exit"',
    'mkdir -p "$EVAL_OUT" "$EVAL_WS"',
    'chmod 600 "$EVAL_SECRETS"',
    // The runner exports ~/.anybench/env to the driver's env; do the same, without a shell echo.
    'set -a; . "$EVAL_SECRETS"; set +a',
    'cd "$root/kit"',
    ...(setup === undefined
      ? ['cp -R "$EVAL_IN/." "$EVAL_WS/"']
      : ['echo "[stub] setup" >&2', `bash ${shQuote(setup)} "$EVAL_WS"`]),
    ...step("start", v.start),
    ...step("ready", v.ready),
    'echo "[stub] run" >&2',
    "rc=0",
    `bash -c ${shQuote(sub(v.run))} || rc=$?`,
    'printf \'%s\\n\' "$rc" > "$root/run.exit"',
    ...step("stop", v.stop),
    'tar -C "$EVAL_OUT" -cf "$root/frozen.tar" .',
    'exit "$rc"',
    "",
  ].join("\n");
  return {
    contenderId,
    workloadId,
    overlayId: overlay?.id ?? null,
    workloadSha256: digest.sha256,
    files: [
      ...files.map(({ kitPath: _k, ...f }) => f),
      text("secrets.env", secrets.map(([k, val]) => `${k}='${val}'\n`).join(""), 0o600),
      ...(proxyEnv.length === 0
        ? []
        : [text("proxy.env", proxyEnv.map(([k, val]) => `${k}='${val}'\n`).join(""), 0o600)]),
      text("run.sh", script, 0o755),
    ],
    script,
    command: `bash ${shQuote(`${root}/run.sh`)}`,
    frozenTar,
    runExitFile,
  };
}

/**
 * Plan one hidden-tests check of a frozen coding-agent trial on the scoring computer. `$AB_RUN`
 * is a pass-through here (one uid); the real gate runner (TDM-51) switches to the contender uid.
 */
export async function planCodingAgentStubGate(
  kit: LoadedKit,
  gateId: string,
  workloadId: string,
  opts: { root: string },
): Promise<CodingAgentStubGatePlan> {
  const root = rootOf(opts.root);
  const gate = kit.gates.find((g) => g.id === gateId);
  if (!gate) throw new CodingAgentStubError(`no gate '${gateId}' in the kit`);
  if (!kit.workloads.some((w) => w.id === workloadId)) {
    throw new CodingAgentStubError(`no workload '${workloadId}' in the kit`);
  }
  const gateDir = KIT_LAYOUT.gateDir(gateId);
  const files = await kitFiles(kit, gateDir, `kit/${gateDir}`);
  if (!files.some((f) => f.to === `kit/${gate.check}`)) {
    throw new CodingAgentStubError(`gate check ${gate.check} is not under ${gateDir}/`);
  }
  if (gate.reference !== undefined && !underDir(normalizeKitPath(gate.reference), gateDir)) {
    const ref = normalizeKitPath(gate.reference);
    files.push(...(await kitFiles(kit, ref, `kit/${ref}`)));
  }
  const frozenTar = `${root}/frozen.tar`;
  const gateJson = `${root}/gate/gate.json`;
  const script = [
    CLI_SCRIPT_SHEBANG,
    `# anybench coding-agent gate stub (TDM-39): gate ${gateId}, workload ${workloadId}. Runs check.sh as its own process.`,
    "set -euo pipefail",
    `root=${shQuote(root)}`,
    'rm -rf "$root/frozen" "$root/run-copy" "$root/gate"',
    'mkdir -p "$root/frozen" "$root/run-copy" "$root/gate"',
    'tar -C "$root/frozen" -xf "$root/frozen.tar"',
    'tar -C "$root/run-copy" -xf "$root/frozen.tar"',
    "# One uid here: AB_RUN passes through. TDM-51's gate runner runs it as the contender uid.",
    'printf \'#!/usr/bin/env bash\\nexec "$@"\\n\' > "$root/ab-run"',
    'chmod 755 "$root/ab-run"',
    `exec env -i PATH="$PATH" HOME="$root/gate" AB_RUN="$root/ab-run" AB_RUN_DIR="$root/run-copy" bash ${shQuote(`${root}/kit/${gate.check}`)} "$root/frozen" ${shQuote(workloadId)} "$root/gate/gate.json"`,
    "",
  ].join("\n");
  return {
    gateId,
    workloadId,
    files: [...files.map(({ kitPath: _k, ...f }) => f), text("gate.sh", script, 0o755)],
    script,
    command: `bash ${shQuote(`${root}/gate.sh`)}`,
    frozenTar,
    gateJson,
  };
}
