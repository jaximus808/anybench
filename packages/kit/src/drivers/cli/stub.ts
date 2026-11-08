// TDM-36 [4.4]: a runner stub for cli kits: what goes on the subject computer, what goes on the
// scoring computer, and the bash each one runs. Used by the example's docker-local proof and the
// tests until the trial executor (bench) drives the real runner.
//
// It follows the runner contract (TDM-46): the driver's verbs run from the kit root with
// EVAL_IN / EVAL_WS / EVAL_OUT / EVAL_SECRETS set and `{in}`, `{out}`, `{workspace}`, `{task}`
// substituted; then EVAL_OUT is frozen into one tar. The two computers are kept apart:
//   - the subject computer gets only `adapters/<contender>/` and the workload input: never
//     gates/, reference/ or proof/ (an overlay's driver is copied over the driver path);
//   - the scoring computer gets only `gates/<gate>/`, the gate's reference and the frozen tar,
//     and runs check.sh as its own process. It never runs contender code.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProofOverlay } from "@anybench/core";
import { canonicalKitPath, hashKitPaths, type HashProblem } from "../../hash.js";
import { KIT_LAYOUT, normalizeKitPath } from "../../layout.js";
import type { LoadedKit } from "../../validate.js";
import { CLI_SCRIPT_SHEBANG, shQuote } from "./shell.js";

/** One file to place on a computer, relative to the trial root there. */
export interface CliStubFile {
  /** Relative to the computer-side root (e.g. `kit/adapters/rg/driver.sh`, `in/pattern.txt`). */
  to: string;
  content: Uint8Array;
  mode: number;
}

export interface CliStubPlan {
  files: CliStubFile[];
  /** The bash to run on the computer (also among `files` as `run.sh`). */
  script: string;
  /** Run it with this command. */
  command: string;
}

export interface CliStubTrialPlan extends CliStubPlan {
  contenderId: string;
  workloadId: string;
  overlayId: string | null;
  /** Workload manifest sha256, recorded per trial (L3). */
  workloadSha256: string;
  /** Where the frozen EVAL_OUT tar lands, absolute on the computer. */
  frozenTar: string;
  /** Exit status of the `run` verb is written here, absolute on the computer. */
  runExitFile: string;
}

export interface CliStubGatePlan extends CliStubPlan {
  gateId: string;
  workloadId: string;
  /** Where to put the trial's frozen tar before running `command`, absolute. */
  frozenTar: string;
  /** Where check.sh writes its verdict, absolute. */
  gateJson: string;
  /** The diff check.sh writes next to the verdict when something differs, absolute. */
  gateDiff: string;
}

export class CliStubError extends Error {
  override readonly name = "CliStubError";
}

function problemsText(problems: readonly HashProblem[]): string {
  return problems.map((p) => `${p.path} (${p.kind})`).join(", ");
}

/** A file to ship plus the kit path it came from (for the subject-computer guard). */
interface SourcedFile extends CliStubFile {
  kitPath: string;
}

async function kitFiles(kit: LoadedKit, rel: string, toPrefix: string): Promise<SourcedFile[]> {
  const { hash, problems } = await hashKitPaths(kit.dir, [rel]);
  if (problems.length > 0) throw new CliStubError(`cannot ship ${rel}: ${problemsText(problems)}`);
  const out: SourcedFile[] = [];
  for (const f of hash.files) {
    const content = new Uint8Array(await readFile(path.join(kit.dir, f.path)));
    const under = f.path.slice(normalizeKitPath(rel).length).replace(/^\//, "");
    out.push({
      kitPath: f.path,
      to: path.posix.join(toPrefix, under),
      content,
      mode: f.path.endsWith(".sh") ? 0o755 : 0o644,
    });
  }
  return out;
}

const strip = ({ kitPath: _k, ...f }: SourcedFile): CliStubFile => f;

/**
 * Kit dirs that must never reach the subject computer (plan.md 17.2 rule 5: answers and gates
 * never reach the subject computer). `proof/` holds oracle solutions and overlays.
 */
export const CLI_SUBJECT_FORBIDDEN_DIRS = [
  KIT_LAYOUT.gatesDir,
  KIT_LAYOUT.referenceDir,
  KIT_LAYOUT.proofDir,
] as const;

function underDir(kitPath: string, dir: string): boolean {
  return kitPath === dir || kitPath.startsWith(`${dir}/`);
}

function findOverlay(kit: LoadedKit, id: string): ProofOverlay {
  const { oracle, do_less, regression } = kit.spec.proof;
  const all = [oracle, ...do_less, regression].filter((o): o is ProofOverlay => o !== undefined);
  const o = all.find((x) => x.id === id);
  if (!o)
    throw new CliStubError(`no proof overlay '${id}' (have: ${all.map((x) => x.id).join(", ")})`);
  return o;
}

function rootOf(root: string): string {
  if (!root.startsWith("/") || root.includes("'") || /\s/.test(root)) {
    throw new CliStubError(
      `computer root must be an absolute path without spaces or quotes: ${root}`,
    );
  }
  return root.replace(/\/+$/, "");
}

const textFile = (to: string, text: string, mode = 0o644): CliStubFile => ({
  to,
  content: new TextEncoder().encode(text),
  mode,
});

export interface PlanCliStubTrialOptions {
  /** Absolute trial root on the subject computer, e.g. `/home/naive/trials/t1`. */
  root: string;
  /** A proof overlay id (oracle, do_less[], regression) applied to the contender. */
  overlay?: string;
  /** Extra non-secret env, e.g. the recipes' exported env (`ANYBENCH_GNU_TIME`). */
  env?: Readonly<Record<string, string>>;
}

/** A file bound for the subject computer: the kit path it came from and where it lands. */
export interface SubjectFileRef {
  kitPath: string;
  to: string;
}

/**
 * Last-resort guard for the subject computer: throws CliStubError if any file comes from
 * gates/, reference/ or proof/. The single exception is `allowed` (an overlay's replacement
 * driver), and only when both its kit path and its destination match exactly.
 */
export function assertSubjectFiles(
  files: readonly SubjectFileRef[],
  allowed?: SubjectFileRef,
): void {
  for (const f of files) {
    const ok = allowed !== undefined && f.kitPath === allowed.kitPath && f.to === allowed.to;
    const hidden = CLI_SUBJECT_FORBIDDEN_DIRS.find((d) => underDir(f.kitPath, d));
    if (hidden !== undefined && !ok) {
      throw new CliStubError(
        `refusing to ship ${f.kitPath} to the subject computer: ${hidden}/ never reaches it`,
      );
    }
  }
}

/** Plan one cli trial of `contender` on `workload`, optionally under a proof overlay. */
export async function planCliStubTrial(
  kit: LoadedKit,
  contenderId: string,
  workloadId: string,
  opts: PlanCliStubTrialOptions,
): Promise<CliStubTrialPlan> {
  const root = rootOf(opts.root);
  const spec = kit.spec.contenders.find((c) => c.id === contenderId);
  const resolved = kit.contenders.find((c) => c.id === contenderId);
  if (!spec || !resolved) throw new CliStubError(`no contender '${contenderId}' in the kit`);
  if (spec.driver.type !== "cli") {
    throw new CliStubError(
      `contender '${contenderId}' has driver.type ${spec.driver.type}, not cli`,
    );
  }
  const workload = kit.workloads.find((w) => w.id === workloadId);
  if (!workload) throw new CliStubError(`no workload '${workloadId}' in the kit`);

  const overlay = opts.overlay === undefined ? undefined : findOverlay(kit, opts.overlay);
  if (overlay?.contender !== undefined && overlay.contender !== contenderId) {
    throw new CliStubError(
      `overlay '${overlay.id}' applies to contender '${overlay.contender}', not '${contenderId}'`,
    );
  }

  // The subject computer gets exactly adapters/<contender>/: a driver anywhere else (say
  // reference/driver.sh) would ship its whole directory, answers included.
  const adapterDir = `${KIT_LAYOUT.adaptersDir}/${contenderId}`;
  const driverPath = canonicalKitPath(resolved.driver);
  if (driverPath === undefined || path.posix.dirname(driverPath) !== adapterDir) {
    throw new CliStubError(
      `contender '${contenderId}': the cli stub only ships ${adapterDir}/, but driver.script is ${resolved.driver}`,
    );
  }
  const files = await kitFiles(kit, adapterDir, `kit/${adapterDir}`);
  if (!files.some((f) => f.to === `kit/${driverPath}`)) {
    throw new CliStubError(`driver ${driverPath} is not under ${adapterDir}/`);
  }
  let overlayDriver: string | undefined;
  if (overlay?.driver_patch !== undefined) {
    overlayDriver = canonicalKitPath(overlay.driver_patch);
    if (
      overlayDriver === undefined ||
      underDir(overlayDriver, KIT_LAYOUT.gatesDir) ||
      underDir(overlayDriver, KIT_LAYOUT.referenceDir)
    ) {
      throw new CliStubError(
        `overlay '${overlay.id}': driver_patch ${overlay.driver_patch} may not come from gates/ or reference/`,
      );
    }
    // A cli overlay's driver_patch is a whole replacement driver.sh (as in TDM-128's kit); the
    // contender's verbs are unchanged, so it is copied over the driver path.
    if (!overlay.driver_patch.endsWith(".sh")) {
      throw new CliStubError(
        `overlay '${overlay.id}': the cli stub takes a replacement driver .sh, not ${overlay.driver_patch}`,
      );
    }
    const patched = await kitFiles(kit, overlayDriver, `kit/${driverPath}`);
    if (patched.length !== 1 || patched[0]!.kitPath !== overlayDriver) {
      throw new CliStubError(`overlay '${overlay.id}': driver_patch must be one file`);
    }
    const i = files.findIndex((f) => f.to === `kit/${driverPath}`);
    files[i] = { ...patched[0]!, to: `kit/${driverPath}`, mode: 0o755 };
  }
  const inputDir = `workloads/${workloadId}/input`;
  files.push(...(await kitFiles(kit, inputDir, "in")));

  // Final guard: nothing from gates/, reference/ or proof/ goes to the subject computer, except
  // the overlay's replacement driver, and only at the driver path.
  assertSubjectFiles(
    files,
    overlayDriver === undefined ? undefined : { kitPath: overlayDriver, to: `kit/${driverPath}` },
  );

  const env: Record<string, string> = {
    ...opts.env,
    ...spec.driver.env,
    ...overlay?.env,
  };
  for (const k of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new CliStubError(`bad env name: ${k}`);
  }
  const paths = {
    in: `${root}/in`,
    out: `${root}/out`,
    workspace: `${root}/ws`,
    task: `${root}/in/instruction.md`,
  };
  const verb = (cmd: string): string =>
    cmd.replace(/\{(in|out|workspace|task)\}/g, (_m, k: keyof typeof paths) => shQuote(paths[k]));
  const v = spec.driver.verbs;
  const step = (name: string, cmd: string | undefined): string[] =>
    cmd === undefined ? [] : [`echo "[stub] ${name}" >&2`, `bash -c ${shQuote(verb(cmd))}`];

  const frozenTar = `${root}/frozen.tar`;
  const runExitFile = `${root}/run.exit`;
  const script = [
    CLI_SCRIPT_SHEBANG,
    `# anybench cli runner stub (TDM-36): contender ${contenderId}, workload ${workloadId}${overlay ? `, overlay ${overlay.id}` : ""}.`,
    "set -euo pipefail",
    `root=${shQuote(root)}`,
    `export EVAL_IN=${shQuote(paths.in)} EVAL_WS=${shQuote(paths.workspace)} EVAL_OUT=${shQuote(paths.out)}`,
    `export EVAL_SECRETS=${shQuote(`${root}/secrets.env`)} EVAL_PHASE=run`,
    ...Object.entries(env).map(([k, val]) => `export ${k}=${shQuote(val)}`),
    'rm -rf "$EVAL_OUT" "$EVAL_WS" "$root/frozen.tar" "$root/run.exit"',
    'mkdir -p "$EVAL_OUT" "$EVAL_WS"',
    ': > "$EVAL_SECRETS"',
    'cd "$root/kit"',
    ...step("start", v.start),
    ...step("ready", v.ready),
    'echo "[stub] run" >&2',
    "rc=0",
    `bash -c ${shQuote(verb(v.run))} || rc=$?`,
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
    workloadSha256: workload.sha256,
    files: [...files.map(strip), textFile("run.sh", script, 0o755)],
    script,
    command: `bash ${shQuote(`${root}/run.sh`)}`,
    frozenTar,
    runExitFile,
  };
}

/** Plan one gate check of a frozen cli trial on the scoring computer. */
export async function planCliStubGate(
  kit: LoadedKit,
  gateId: string,
  workloadId: string,
  opts: { root: string },
): Promise<CliStubGatePlan> {
  const root = rootOf(opts.root);
  const gate = kit.gates.find((g) => g.id === gateId);
  if (!gate) throw new CliStubError(`no gate '${gateId}' in the kit`);
  if (!kit.workloads.some((w) => w.id === workloadId)) {
    throw new CliStubError(`no workload '${workloadId}' in the kit`);
  }
  const files = await kitFiles(kit, `gates/${gateId}`, `kit/gates/${gateId}`);
  if (!files.some((f) => f.to === `kit/${gate.check}`)) {
    throw new CliStubError(`gate check ${gate.check} is not under gates/${gateId}/`);
  }
  if (gate.reference !== undefined) {
    const ref = normalizeKitPath(gate.reference);
    files.push(...(await kitFiles(kit, ref, `kit/${ref}`)));
  }
  const frozenTar = `${root}/frozen.tar`;
  const gateJson = `${root}/gate/gate.json`;
  const script = [
    CLI_SCRIPT_SHEBANG,
    `# anybench cli gate stub (TDM-36): gate ${gateId}, workload ${workloadId}. Runs check.sh as its own process.`,
    "set -euo pipefail",
    `root=${shQuote(root)}`,
    'rm -rf "$root/frozen" "$root/gate"',
    'mkdir -p "$root/frozen" "$root/gate"',
    'tar -C "$root/frozen" -xf "$root/frozen.tar"',
    `exec bash ${shQuote(`${root}/kit/${gate.check}`)} "$root/frozen" ${shQuote(workloadId)} "$root/gate/gate.json"`,
    "",
  ].join("\n");
  return {
    gateId,
    workloadId,
    files: [...files.map(strip), textFile("gate.sh", script, 0o755)],
    script,
    command: `bash ${shQuote(`${root}/gate.sh`)}`,
    frozenTar,
    gateJson,
    gateDiff: `${root}/gate/gate.diff`,
  };
}
