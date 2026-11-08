// A runner stub for harness kits (TDM-41 [4.9]): what goes on the subject computer and the bash it
// runs, for the docker-local proof and the tests, until the trial executor drives the real runner.
// Same contract as the cli stub (TDM-36): verbs run from the kit root with EVAL_IN / EVAL_WS /
// EVAL_OUT / EVAL_SECRETS set, then EVAL_OUT is frozen into one tar.
//
// The subject computer gets exactly `adapters/<contender>/` (run.sh, harness.yaml, prompts, the
// board helper), the workload's own folder (input, instruction, setup) and nothing else: never
// gates/, reference/ or proof/ (assertSubjectFiles, plan.md 17.2 rule 5). The workspace the
// scoring computer grades is the `workspace/` run.sh copies into EVAL_OUT; the gate runs elsewhere
// (planCliStubGate works for any kit, or packages/bench gate.ts with $AB_RUN).
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProofOverlay } from "@anybench/core";
import { canonicalKitPath, hashKitPaths } from "../../hash.js";
import { KIT_LAYOUT, normalizeKitPath } from "../../layout.js";
import type { LoadedKit } from "../../validate.js";
import { CLI_SCRIPT_SHEBANG, shQuote } from "../cli/shell.js";
import { assertSubjectFiles, type CliStubFile } from "../cli/stub.js";
import { contenderDriverEnv } from "./env.js";

export class HarnessStubError extends Error {
  override readonly name = "HarnessStubError";
}

export interface HarnessStubTrialPlan {
  contenderId: string;
  workloadId: string;
  overlayId: string | null;
  workloadSha256: string;
  /** Files to place on the computer, relative to `root`. */
  files: CliStubFile[];
  script: string;
  command: string;
  /** Absolute paths on the computer. */
  frozenTar: string;
  runExitFile: string;
  outDir: string;
}

export interface PlanHarnessStubTrialOptions {
  /** Absolute trial root on the subject computer, e.g. `/home/naive/trials/t1`. */
  root: string;
  /** A proof overlay id applied to the contender (its driver_patch replaces driver.sh). */
  overlay?: string;
  /** One `vary` setup, e.g. `{ TANDEM_WORKERS: "3" }`; wins over driver.env. */
  setup?: Readonly<Record<string, string>>;
  /** Extra non-secret env (recipes' exports, TANDEM_HOME, PATH additions). */
  env?: Readonly<Record<string, string>>;
}

async function kitFiles(kit: LoadedKit, rel: string, toPrefix: string) {
  const { hash, problems } = await hashKitPaths(kit.dir, [rel]);
  if (problems.length > 0)
    throw new HarnessStubError(
      `cannot ship ${rel}: ${problems.map((p) => `${p.path} (${p.kind})`).join(", ")}`,
    );
  const out: (CliStubFile & { kitPath: string })[] = [];
  for (const f of hash.files) {
    const under = f.path.slice(normalizeKitPath(rel).length).replace(/^\//, "");
    out.push({
      kitPath: f.path,
      to: path.posix.join(toPrefix, under),
      content: new Uint8Array(await readFile(path.join(kit.dir, f.path))),
      mode: f.path.endsWith(".sh") || f.path.endsWith("/claude") ? 0o755 : 0o644,
    });
  }
  return out;
}

function rootOf(root: string): string {
  if (!root.startsWith("/") || root.includes("'") || /\s/.test(root))
    throw new HarnessStubError(
      `computer root must be an absolute path without spaces or quotes: ${root}`,
    );
  return root.replace(/\/+$/, "");
}

function findOverlay(kit: LoadedKit, id: string): ProofOverlay {
  const { oracle, do_less, regression } = kit.spec.proof;
  const all = [oracle, ...do_less, regression].filter((o): o is ProofOverlay => o !== undefined);
  const o = all.find((x) => x.id === id);
  if (!o) throw new HarnessStubError(`no proof overlay '${id}'`);
  return o;
}

/** Plan one harness trial of `contender` on `workload`. */
export async function planHarnessStubTrial(
  kit: LoadedKit,
  contenderId: string,
  workloadId: string,
  opts: PlanHarnessStubTrialOptions,
): Promise<HarnessStubTrialPlan> {
  const root = rootOf(opts.root);
  const spec = kit.spec.contenders.find((c) => c.id === contenderId);
  const resolved = kit.contenders.find((c) => c.id === contenderId);
  if (!spec || !resolved) throw new HarnessStubError(`no contender '${contenderId}' in the kit`);
  if (spec.driver.type !== "harness")
    throw new HarnessStubError(
      `contender '${contenderId}' has driver.type ${spec.driver.type}, not harness`,
    );
  const workload = kit.workloads.find((w) => w.id === workloadId);
  const wspec = kit.spec.workloads.find((w) => w.id === workloadId);
  if (!workload || !wspec) throw new HarnessStubError(`no workload '${workloadId}' in the kit`);

  const adapterDir = `${KIT_LAYOUT.adaptersDir}/${contenderId}`;
  const driverPath = canonicalKitPath(resolved.driver);
  if (driverPath === undefined || path.posix.dirname(driverPath) !== adapterDir)
    throw new HarnessStubError(
      `the harness stub only ships ${adapterDir}/, but driver.script is ${resolved.driver}`,
    );
  const files = await kitFiles(kit, adapterDir, `kit/${adapterDir}`);

  const overlay = opts.overlay === undefined ? undefined : findOverlay(kit, opts.overlay);
  if (overlay?.contender !== undefined && overlay.contender !== contenderId)
    throw new HarnessStubError(
      `overlay '${overlay.id}' applies to '${overlay.contender}', not '${contenderId}'`,
    );
  let allowed: { kitPath: string; to: string } | undefined;
  if (overlay?.driver_patch !== undefined) {
    const p = canonicalKitPath(overlay.driver_patch);
    if (
      p === undefined ||
      !p.endsWith(".sh") ||
      p.startsWith(`${KIT_LAYOUT.gatesDir}/`) ||
      p.startsWith(`${KIT_LAYOUT.referenceDir}/`)
    )
      throw new HarnessStubError(
        `overlay '${overlay.id}': driver_patch must be a .sh outside gates/ and reference/`,
      );
    const patched = await kitFiles(kit, p, `kit/${driverPath}`);
    if (patched.length !== 1)
      throw new HarnessStubError(`overlay '${overlay.id}': driver_patch must be one file`);
    const i = files.findIndex((f) => f.to === `kit/${driverPath}`);
    allowed = { kitPath: p, to: `kit/${driverPath}` };
    files[i] = { ...patched[0]!, ...allowed, mode: 0o755 };
  }

  // The workload's own folder: input, instruction, setup. Answers never live under workloads/.
  const workloadDir = `workloads/${workloadId}`;
  for (const rel of [wspec.input, wspec.instruction, wspec.setup]) {
    const p = rel === undefined ? undefined : canonicalKitPath(rel);
    if (p !== undefined && p !== workloadDir && !p.startsWith(`${workloadDir}/`))
      throw new HarnessStubError(`workload '${workloadId}': ${rel} is outside ${workloadDir}/`);
  }
  files.push(...(await kitFiles(kit, workloadDir, `kit/${workloadDir}`)));
  assertSubjectFiles(files, allowed);

  const env: Record<string, string> = {
    ...opts.env,
    ...contenderDriverEnv(kit.spec, contenderId, workloadId, opts.setup),
    ...overlay?.env,
  };
  for (const k of Object.keys(env))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HarnessStubError(`bad env name: ${k}`);

  const input = wspec.input === undefined ? undefined : canonicalKitPath(wspec.input);
  const instruction =
    wspec.instruction === undefined ? undefined : canonicalKitPath(wspec.instruction);
  const setup = wspec.setup === undefined ? undefined : canonicalKitPath(wspec.setup);
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
  const script = [
    CLI_SCRIPT_SHEBANG,
    `# anybench harness runner stub (TDM-41): contender ${contenderId}, workload ${workloadId}${overlay ? `, overlay ${overlay.id}` : ""}.`,
    "set -euo pipefail",
    `root=${shQuote(root)}`,
    `export EVAL_IN=${shQuote(paths.in)} EVAL_WS=${shQuote(paths.workspace)} EVAL_OUT=${shQuote(paths.out)}`,
    `export EVAL_SECRETS=${shQuote(`${root}/secrets.env`)} EVAL_PHASE=run EVAL_TRIAL_ID=${shQuote(path.posix.basename(root))}`,
    ...Object.entries(env).map(([k, val]) => `export ${k}=${shQuote(val)}`),
    'rm -rf "$EVAL_IN" "$EVAL_OUT" "$EVAL_WS" "$root/frozen.tar" "$root/run.exit"',
    'mkdir -p "$EVAL_IN" "$EVAL_OUT"',
    '[ -f "$EVAL_SECRETS" ] || : > "$EVAL_SECRETS"',
    'cd "$root/kit"',
    ...(input === undefined ? [] : [`cp -R ${shQuote(input)}/. "$EVAL_IN/"`]),
    ...(instruction === undefined ? [] : [`cp ${shQuote(instruction)} "$EVAL_IN/instruction.md"`]),
    // L3: the workload's setup builds EVAL_WS; without one, the input becomes a one-commit repo.
    ...(setup !== undefined
      ? [`bash ${shQuote(setup)} "$EVAL_WS"`]
      : [
          'mkdir -p "$EVAL_WS" && cp -R "$EVAL_IN/." "$EVAL_WS/" && rm -f "$EVAL_WS/instruction.md"',
          'git -C "$EVAL_WS" init -q && git -C "$EVAL_WS" add -A && git -C "$EVAL_WS" -c user.name=kit -c user.email=kit@anybench.invalid commit -qm start',
        ]),
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
    files: [
      ...files.map(({ kitPath: _k, ...f }) => f),
      { to: "run.sh", content: new TextEncoder().encode(script), mode: 0o755 },
    ],
    script,
    command: `bash ${shQuote(`${root}/run.sh`)}`,
    frozenTar: `${root}/frozen.tar`,
    runExitFile: `${root}/run.exit`,
    outDir: paths.out,
  };
}
