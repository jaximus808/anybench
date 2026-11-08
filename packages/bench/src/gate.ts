// TDM-51 [5.6]: the gate runner on a fresh scoring computer (plan.md P2 L5, P3, 17.2 rules 1, 5, 9).
//
// One call scores one trial:
//   1. create (or fork the `scoring` profile snapshot) a FRESH computer through the registry, so it
//      has a `computers` row and a trial tag. It never ran the subject: we refuse a snapshot that
//      held one, and nothing of the contender is installed on it.
//   2. put the scoring bundle on it (`gates/`, `reference/`, `workloads/`: only kit files needed to
//      score, see SCORING_BUNDLE_ROOTS) and pull the frozen outputs (`out.tar.gz` from the trial's
//      artifact prefix) by presigned GET, or push them when the worker already holds the bytes.
//      The outputs are untrusted data: their sha256 is checked, they are unpacked by the sandbox
//      uid, special files are dropped, and the pristine copy is made read-only and root-owned.
//   3. for each gate, run `check.sh <frozen-out> <workload-id> <gate.json>` OUT OF PROCESS:
//      a detached root wrapper (so a long gate outlives Naïve's 10-minute exec cap) starts the
//      check as the sandbox uid (`abgate`, never root, never the worker), in a clean env, under
//      `timeout`, on a private writable copy of the outputs, with the kit read-only. After it
//      exits, every process of the sandbox uid is killed BEFORE the verdict is read, so nothing
//      the contender left running can rewrite it. The verdict is copied by root only if it is a
//      regular, single-link file owned by the sandbox uid and at most GATE_VERDICT_MAX_BYTES.
//   4. destroy the computer (always, also on error).
//
// Fail closed: a missing, unreadable, oversized or invalid gate.json, a non-zero exit, a timeout or
// missing frozen outputs is a FAIL with the reason, never a pass and never "skipped". Infra trouble
// on our side (computer won't start, download or checksum fails, setup breaks) throws
// GateInfraError instead, so the caller retries rather than failing a contender for our fault.
//
// Integrity (plan.md 17.2 rule 5): results come back ONLY through the provider (the worker reading
// the scoring computer). Nothing here uses or accepts the per-trial runner token, which the agent
// under test can read; the runner ingest refuses `trial.gate` events for the same reason.
//
// The sandbox is a plug (GateSandbox). The default runs the check as a separate uid. The in-kit
// grade harness that also runs contender code under its own uid, with the tests out of its reach,
// is [16.1] (TDM-172): it plugs in here as another GateSandbox and/or through the AB_* env the
// check receives, without changing the runner.
//
// Contender code never runs as the check's uid: the check runs as `abgate`, and it runs contender
// code only through `$AB_RUN` (uid `abrun`, util-linux su + a PAM rule for exactly abgate → abrun),
// on its own writable copy. abrun can't read the kit (reference, hidden tests), can't write the
// verdict dir and can't signal the check. Any abgate/abrun process still alive when the check
// exits fails the gate closed. Kits must call contender code through "$AB_RUN"; a check that runs
// it directly gives that code the check's uid (the kit's fault, caught by [16.10] proof checks).
// In-process tampering inside a test runner (patching node:assert) is [16.1] (TDM-172).

import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  GateResultSchema,
  GateSchema,
  KitPathSchema,
  KitSlugSchema,
  type Gate,
  type GateResult,
} from "@anybench/core";
import type { ComputerRegistry } from "@anybench/envs";
import type { ComputerInfo } from "@anybench/providers";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Constants

/** The VM profile gates run on (plan.md P1): runner, test toolchains, reference parsers; never the subject. */
export const SCORING_PROFILE = "scoring" as const;
/** plan.md P1 profile table: scoring = 2 vCPU / 4 GB. */
export const DEFAULT_SCORING_SPEC = { vcpu: 2, memoryMb: 4096, diskGb: 10 } as const;
/** Root-owned work area on the scoring computer (outside the home putFile writes to). */
export const SCORE_ROOT = "/var/lib/anybench-score";
/** Inbox under the computer's home for putFile (scoring bundle, pushed outputs, scripts). */
export const SCORE_INBOX = ".anybench/score";
/** The uid checks run as. */
export const GATE_SANDBOX_USER = "abgate";
/** The uid contender code runs as, through `$AB_RUN`. */
export const GATE_RUN_USER = "abrun";
/** gate.json larger than this is refused (fail closed). */
export const GATE_VERDICT_MAX_BYTES = 64 * 1024;
/** Used when a gate sets no `timeout_s`. */
export const DEFAULT_GATE_TIMEOUT_S = 600;
/**
 * Kit top-level dirs that may reach the scoring computer. `workloads/` is the shared input (some
 * checks need it, e.g. http-agent conversations; plan.md 17.2 rule 5 keeps answers out of it).
 * Never `adapters/` (the subject) or `proof/` (the oracle).
 */
export const SCORING_BUNDLE_ROOTS = ["gates", "reference", "workloads"] as const;
/** The bundle name the runner uploads under the trial prefix (packages/runner UploadConfig). */
export const FROZEN_BUNDLE_NAME = "out.tar.gz";

const REASON_MAX_CHARS = 2000;
const LOG_TAIL_MAX_CHARS = 2000;
const EVIDENCE_MAX = 100;

// ---------------------------------------------------------------------------------------------
// Inputs

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars");
const bytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array, "expected bytes");

/** One file of the scoring bundle, relative to the kit root. */
export const ScoringFileSchema = z.object({
  path: KitPathSchema,
  data: bytesSchema,
});
export type ScoringFile = z.infer<typeof ScoringFileSchema>;

/** Where the trial's frozen outputs (the runner's `out.tar.gz`) come from. */
export const FrozenOutputsSchema = z.discriminatedUnion("kind", [
  /** Presigned GET (ArtifactStore.createDownload). The URL never goes on a command line. */
  z.object({
    kind: z.literal("url"),
    url: z.url(),
    sha256: sha256Schema,
    sizeBytes: z.int().nonnegative(),
  }),
  /** The worker holds the bytes (fs/read fallback, tests) and pushes them with putFile. */
  z.object({ kind: z.literal("bytes"), data: bytesSchema, sha256: sha256Schema.optional() }),
  /** No bundle exists: every gate fails closed without starting a computer. */
  z.object({ kind: z.literal("missing"), reason: z.string().min(1) }),
]);
export type FrozenOutputs = z.infer<typeof FrozenOutputsSchema>;

/** The scoring profile: its snapshot when one is built ([3.9]), else a fresh base computer. */
export const ScoringProfileSchema = z.object({
  snapshotId: z.string().min(1).optional(),
  vcpu: z.int().min(1).max(16).default(DEFAULT_SCORING_SPEC.vcpu),
  memoryMb: z.int().min(512).default(DEFAULT_SCORING_SPEC.memoryMb),
  diskGb: z.int().min(1).default(DEFAULT_SCORING_SPEC.diskGb),
});
export type ScoringProfileInput = z.input<typeof ScoringProfileSchema>;

export const GateRunInputSchema = z.object({
  runId: z.string().min(1),
  trialId: z.string().min(1),
  workloadId: KitSlugSchema,
  /** The kit's gates. Empty (a kit with only ungated reviewed requirements) scores nothing. */
  gates: z.array(GateSchema),
  frozen: FrozenOutputsSchema,
  scoring: z.array(ScoringFileSchema),
  profile: ScoringProfileSchema.default({
    vcpu: DEFAULT_SCORING_SPEC.vcpu,
    memoryMb: DEFAULT_SCORING_SPEC.memoryMb,
    diskGb: DEFAULT_SCORING_SPEC.diskGb,
  }),
  /** Snapshots that ever held a subject. The scoring computer may never be forked from one. */
  subjectSnapshotIds: z.array(z.string().min(1)).default([]),
});
export type GateRunInput = z.input<typeof GateRunInputSchema>;

// ---------------------------------------------------------------------------------------------
// Outputs

/** How a gate's verdict was obtained. Anything but `verdict` is a fail-closed FAIL. */
export const GateOutcomeStatusSchema = z.enum([
  "verdict", // check exited 0 and wrote a valid gate.json
  "no_verdict", // no gate.json (or not a regular single-link file, or too large)
  "invalid_verdict", // gate.json is not a valid GateResult
  "check_failed", // check exited non-zero
  "timeout", // check ran past its timeout
  "lingering", // a process of the check's or the contender's uid outlived the check
  "no_outputs", // the frozen outputs are missing or could not be unpacked
]);
export type GateOutcomeStatus = z.infer<typeof GateOutcomeStatusSchema>;

export const GateOutcomeSchema = z.object({
  /** Always has `applicable` set; `applicable: false` always comes with `pass: false`. */
  result: GateResultSchema.extend({ applicable: z.boolean() }),
  status: GateOutcomeStatusSchema,
  exit_code: z.int().nullable(),
  timed_out: z.boolean(),
  duration_ms: z.int().nonnegative(),
  /** Last lines of the check's stdout+stderr (untrusted text, for the reason drawer). */
  log_tail: z.string(),
  /**
   * The FAIL is the kit's (or our) fault, not the contender's: the check broke (non-zero exit with
   * no verdict, no or invalid gate.json, the check's own process left running) or the gate was
   * lost. Contender code can't touch the verdict dir, so these never come from the contender.
   * The trial.gate job turns them into failed_infra / failure_class "kit" (never billed).
   */
  kit_fault: z.boolean(),
});
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

/** What `trials.gate` holds: one outcome per kit gate plus where and how it was scored. */
export const TrialGateRecordSchema = z.object({
  version: z.literal(1),
  trial_id: z.string().min(1),
  workload_id: z.string().min(1),
  scored_at: z.iso.datetime({ offset: true }),
  scoring_computer: z
    .object({
      provider: z.string().min(1),
      computer_id: z.string().min(1),
      provider_id: z.string().min(1),
      snapshot_id: z.string().nullable(),
      destroyed: z.boolean(),
    })
    .nullable(),
  /** GateSandbox.level the checks ran under. */
  sandbox: z.string().min(1),
  /** sha256 of the frozen bundle as verified on the scoring computer (null when missing). */
  outputs_sha256: sha256Schema.nullable(),
  gates: z.record(KitSlugSchema, GateOutcomeSchema),
  // TODO([16.5] metric plumbing): gates may emit metric rows (e.g. api_p95_ms) with collector
  // "gate"; CollectorNameSchema has no "gate" yet, so they are not collected here.
});
export type TrialGateRecord = z.infer<typeof TrialGateRecordSchema>;

/** gate id → gate.json, the shape `TrialResult.gates` (score.ts) reads. */
export function gateResultsOf(record: TrialGateRecord): Record<string, GateResult> {
  return Object.fromEntries(Object.entries(record.gates).map(([id, o]) => [id, o.result]));
}

/**
 * One GateResult for the trial drawer (core TrialDetail.gate): passes only when at least one gate
 * applied and every applicable gate passed. Not-applicable gates neither pass nor fail it.
 */
export function trialGateSummary(record: TrialGateRecord): GateResult {
  const entries = Object.entries(record.gates);
  const applicable = entries.filter(([, o]) => o.result.applicable);
  const failed = applicable.filter(([, o]) => !o.result.pass);
  const evidence = [...new Set(applicable.flatMap(([, o]) => o.result.evidence))];
  if (applicable.length === 0) {
    return { pass: false, applicable: false, reason: "no gate applies to this workload", evidence };
  }
  const reason =
    failed.length === 0
      ? `${applicable.length}/${applicable.length} gates passed`
      : failed.map(([id, o]) => `${id}: ${o.result.reason}`).join("; ");
  return { pass: failed.length === 0, applicable: true, reason, evidence };
}

// ---------------------------------------------------------------------------------------------
// Errors

/** Our fault (computer, transfer, setup): retry; never recorded as a contender failure. */
export class GateInfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GateInfraError";
  }
}

/** The kit cannot be scored (missing check script, bundle file outside the allowed roots). */
export class GateKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateKitError";
  }
}

// ---------------------------------------------------------------------------------------------
// Sandbox plug

/** Paths the sandbox shell fragments may refer to (all on the scoring computer). */
export interface GateSandboxPaths {
  root: string;
}

/**
 * How a check is isolated on the scoring computer. Every fragment is bash run as root.
 *
 * Two identities: the CHECK runs as `user`; CONTENDER CODE the check executes (hidden tests,
 * the contender's binary) runs as `runUser`, only through the `$AB_RUN` command the check is
 * given, on a writable copy of the outputs in `$AB_RUN_DIR`. `runUser` can't read the kit, can't
 * write the verdict dir and can't signal the check. [16.1] (TDM-172) can plug a stronger one in.
 */
export interface GateSandbox {
  /** Recorded in TrialGateRecord.sandbox (and so on the report's trust checklist). */
  readonly level: string;
  /** The uid the check runs as. Owns its private copy of the outputs and its verdict dir. */
  readonly user: string;
  /** The uid contender code runs as through `$AB_RUN`. null: this sandbox gives no `$AB_RUN`. */
  readonly runUser: string | null;
  /**
   * Idempotent setup: create the uids, make `$AB_RUN` work (it must end up at
   * `<root>/run-bin/ab-run`) and self-test it. Exit non-zero on failure.
   */
  setup(paths: GateSandboxPaths): string;
  /** A command prefix that runs the rest of the line as `user`. */
  runAs(): string;
  /** Kill every process of `user` and `runUser`. Must not fail when there are none. */
  killAll(): string;
}

const USER_RE = /^[a-z_][a-z0-9_-]{0,30}$/;

function killUser(user: string): string {
  // kill -1 as the user signals every process that user owns (the shell too, hence `|| true`).
  return [
    `for _ in 1 2 3; do`,
    `  if command -v runuser >/dev/null 2>&1; then runuser -u ${user} -- sh -c 'kill -9 -1' >/dev/null 2>&1 || true;`,
    `  else setpriv --reuid=${user} --regid=${user} --init-groups sh -c 'kill -9 -1' >/dev/null 2>&1 || true; fi`,
    `done`,
  ].join("\n");
}

/**
 * The `$AB_RUN` command: `"$AB_RUN" <cmd> [args...]` runs as the contender uid, in the caller's
 * cwd (which must be under `$AB_RUN_DIR`), with a clean env (no AB_* paths) and
 * HOME=TMPDIR=`$AB_RUN_HOME`. The uid switch is util-linux `su` (setuid root on ubuntu:24.04,
 * nothing to install), allowed by a PAM rule for exactly check uid → run uid.
 */
function abRunScript(runUser: string): string {
  return [
    "#!/usr/bin/env bash",
    `# AB_RUN: run contender code as ${runUser}, never as the check's uid. Usage: "$AB_RUN" <cmd> [args...]`,
    "set -u",
    '[ "$#" -ge 1 ] || { echo "usage: \\$AB_RUN <cmd> [args...]" >&2; exit 2; }',
    'h="${AB_RUN_HOME:-/tmp}"',
    `inner="cd $(printf '%q' "$PWD") && exec env -i PATH=${CHECK_PATH_ENV} HOME=$(printf '%q' "$h") TMPDIR=$(printf '%q' "$h") LC_ALL=C LANG=C $(printf '%q ' "$@")"`,
    `exec su ${runUser} -s /bin/bash -c "$inner"`,
  ].join("\n");
}

/**
 * Default sandbox (level `uid-split`): the check runs as `abgate`, contender code as `abrun`
 * through `$AB_RUN`. Needs root once for setup (useradd, a PAM rule in /etc/pam.d/su).
 */
export function uidGateSandbox(opts: { user?: string; runUser?: string } = {}): GateSandbox {
  const user = opts.user ?? GATE_SANDBOX_USER;
  const runUser = opts.runUser ?? GATE_RUN_USER;
  for (const u of [user, runUser]) {
    if (!USER_RE.test(u)) throw new Error(`bad sandbox user name: ${u}`);
  }
  if (user === runUser) throw new Error("the check and contender code need two different uids");
  const tag = "# anybench-gate";
  return {
    level: "uid-split",
    user,
    runUser,
    setup: (paths) =>
      [
        `mk() { id -u "$1" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell "$2" "$1" \\`,
        `  || { echo "cannot create sandbox user $1" >&2; exit 1; }; }`,
        `mk ${user} /usr/sbin/nologin`,
        `mk ${runUser} /bin/bash`,
        `[ "$(id -u ${user})" != 0 ] && [ "$(id -u ${runUser})" != 0 ] || { echo "sandbox user is root" >&2; exit 1; }`,
        `command -v runuser >/dev/null 2>&1 || command -v setpriv >/dev/null 2>&1 || { echo "need runuser or setpriv" >&2; exit 1; }`,
        `su_bin="$(command -v su)" && [ -u "$su_bin" ] || { echo "need a setuid su" >&2; exit 1; }`,
        `[ -f /etc/pam.d/su ] || { echo "no /etc/pam.d/su" >&2; exit 1; }`,
        // Exactly one rule pair: target ${runUser}, caller ${user}. Inserted right after pam_rootok.
        `if ! grep -q '${tag}' /etc/pam.d/su; then`,
        `  awk '{print} !d && /^auth[ \\t]+sufficient[ \\t]+pam_rootok\\.so/ {print "auth [success=ignore default=1] pam_succeed_if.so quiet user = ${runUser} ${tag}"; print "auth sufficient pam_succeed_if.so quiet use_uid user = ${user} ${tag}"; d=1}' /etc/pam.d/su > /etc/pam.d/su.ab-tmp \\`,
        `    && cat /etc/pam.d/su.ab-tmp > /etc/pam.d/su; rm -f /etc/pam.d/su.ab-tmp`,
        `fi`,
        `[ "$(grep -c '${tag}' /etc/pam.d/su)" = 2 ] || { echo "PAM rule for ${user} -> ${runUser} not installed" >&2; exit 1; }`,
        `mkdir -p ${sq(paths.root)}/run-bin && chmod 755 ${sq(paths.root)}/run-bin`,
        `cat > ${sq(paths.root)}/run-bin/ab-run <<'AB_RUN_EOF'`,
        abRunScript(runUser),
        `AB_RUN_EOF`,
        `chown 0:0 ${sq(paths.root)}/run-bin/ab-run && chmod 755 ${sq(paths.root)}/run-bin/ab-run`,
        // Self-test: the check uid becomes the run uid, and the run uid can't become the check uid.
        `[ "$(cd / && runuser -u ${user} -- ${sq(paths.root)}/run-bin/ab-run id -un </dev/null 2>/dev/null)" = ${runUser} ] \\`,
        `  || { echo "${user} cannot run code as ${runUser}" >&2; exit 1; }`,
        `if runuser -u ${runUser} -- su ${user} -s /bin/bash -c true </dev/null >/dev/null 2>&1; then echo "${runUser} can become ${user}" >&2; exit 1; fi`,
      ].join("\n"),
    runAs: () =>
      `$(if command -v runuser >/dev/null 2>&1; then echo "runuser -u ${user} --"; else echo "setpriv --reuid=${user} --regid=${user} --init-groups"; fi)`,
    killAll: () => [killUser(runUser), killUser(user)].join("\n"),
  };
}

// ---------------------------------------------------------------------------------------------
// Scoring bundle

function allowedRoots(gates: readonly Gate[]): string[] {
  const roots: string[] = [...SCORING_BUNDLE_ROOTS];
  for (const g of gates) if (g.reference) roots.push(g.reference.replace(/\/+$/, ""));
  return roots;
}

function underRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(`${r}/`));
}

/** The check script of a gate, relative to the kit root. */
export function gateCheckPath(gate: Gate): string {
  return gate.check ?? `gates/${gate.id}/check.sh`;
}

/**
 * Read the scoring bundle from a kit directory: every regular file under `gates/`, `reference/`
 * and each gate's `reference` path. Symlinks are refused (a kit file must not point anywhere
 * else). Nothing from adapters/ or proof/ is ever included.
 */
export async function collectScoringFiles(
  kitDir: string,
  gates: readonly Gate[],
): Promise<ScoringFile[]> {
  const out = new Map<string, ScoringFile>();
  async function walk(rel: string): Promise<void> {
    const abs = join(kitDir, rel);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) throw new GateKitError(`kit file ${rel} is a symlink`);
    if (st.isDirectory()) {
      for (const name of (await readdir(abs)).sort()) await walk(posix.join(rel, name));
    } else if (st.isFile()) {
      out.set(rel, { path: rel, data: new Uint8Array(await readFile(abs)) });
    }
  }
  for (const root of allowedRoots(gates)) await walk(root);
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------
// Shell generation

function sq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Every script re-runs itself as root (docker-local exec is root; Naïve has passwordless sudo). */
const PRELUDE = [
  "#!/usr/bin/env bash",
  "set -u",
  'if [ "$(id -u)" -ne 0 ]; then exec sudo -n -- bash "$0" "$@"; fi',
  "export LC_ALL=C",
].join("\n");

/** Run a root-only script (mode 0700 under SCORE_ROOT): directly as root, else through sudo. */
function asRoot(path: string): string {
  const f = sq(path);
  return `if [ "$(id -u)" -eq 0 ]; then bash ${f}; else sudo -n -- bash ${f}; fi`;
}

const CHECK_PATH_ENV = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface ScriptCtx {
  home: string;
  sandbox: GateSandbox;
}

function inbox(ctx: ScriptCtx): string {
  return posix.join(ctx.home, SCORE_INBOX);
}

/** Fetch the presigned URL (read from a 0600 file, never argv of the exec) into the inbox. */
function fetchScript(ctx: ScriptCtx): string {
  const IN = sq(inbox(ctx));
  return [
    "#!/usr/bin/env bash",
    "set -u",
    `IN=${IN}`,
    'dest="$IN/outputs.tar.gz"; urlf="$IN/fetch.url"',
    'rm -f "$dest"',
    "if command -v curl >/dev/null 2>&1; then",
    `  sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/^/url = "/' -e 's/$/"/' "$urlf" | curl -fsSL --retry 3 --max-time 900 -K - -o "$dest"`,
    "elif command -v wget >/dev/null 2>&1; then",
    '  wget -q -T 900 -O "$dest" -i "$urlf"',
    "elif command -v python3 >/dev/null 2>&1; then",
    `  python3 -c 'import sys,urllib.request,shutil; u=open(sys.argv[1]).read().strip(); r=urllib.request.urlopen(u, timeout=900); shutil.copyfileobj(r, open(sys.argv[2],"wb"))' "$urlf" "$dest"`,
    "elif command -v node >/dev/null 2>&1; then",
    `  node -e 'const fs=require("fs");fetch(fs.readFileSync(process.argv[1],"utf8").trim()).then(async r=>{if(!r.ok){console.error("HTTP "+r.status);process.exit(1)}fs.writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(String(e));process.exit(1)})' "$urlf" "$dest"`,
    "else",
    '  echo "no curl, wget, python3 or node to download with" >&2; exit 127',
    "fi",
    "rc=$?",
    'rm -f "$urlf"',
    "exit $rc",
  ].join("\n");
}

/**
 * Root setup: sandbox uid, work tree, kit (read-only), frozen outputs (sha256-checked, unpacked
 * by the sandbox uid, special files dropped, then root-owned and read-only). Last stdout line:
 * `AB_SETUP frozen=<ok|missing|invalid> sha256=<hex|->`.
 */
function setupScript(ctx: ScriptCtx, expectSha: string | null): string {
  const S = sq(SCORE_ROOT);
  const U = ctx.sandbox.user;
  return [
    PRELUDE,
    `S=${S}; IN=${sq(inbox(ctx))}; U=${sq(U)}`,
    'die() { echo "AB_SETUP_FAIL $*"; exit 3; }',
    "# work tree: root-owned. status/, logs/, bin/ are root-only (read back through sudo).",
    'rm -rf "$S" && mkdir -p "$S/kit" "$S/work" "$S/verdict" "$S/status" "$S/logs" "$S/bin" || die "mkdir $S"',
    'chown -R 0:0 "$S"; chmod 755 "$S" "$S/work" "$S/verdict"; chmod 700 "$S/status" "$S/logs" "$S/bin"',
    "# sandbox (uids, $AB_RUN)",
    "(",
    ctx.sandbox.setup({ root: SCORE_ROOT }),
    ') || die "sandbox setup failed"',
    ctx.sandbox.killAll(),
    "# kit: readable by the check uid only (contender code can't read the reference), writable by no one",
    'if [ -d "$IN/kit" ]; then cp -R "$IN/kit/." "$S/kit/" || die "copy kit"; fi',
    'cp "$IN"/gate-*.sh "$IN/kill.sh" "$S/bin/" 2>/dev/null || die "copy scripts"',
    'chown -R 0:"$(id -g "$U")" "$S/kit"; chmod -R u=rwX,g=rX,o= "$S/kit"; chmod -R a-w "$S/kit"',
    'chown -R 0:0 "$S/bin"; chmod 700 "$S/bin"/*',
    "# frozen outputs: untrusted data",
    "frozen=missing; sha=-",
    'if [ -f "$IN/outputs.tar.gz" ]; then',
    '  sha="$(sha256sum "$IN/outputs.tar.gz" | cut -d" " -f1)"',
    expectSha
      ? `  [ "$sha" = ${sq(expectSha)} ] || die "outputs sha256 mismatch: got $sha"`
      : "  :",
    '  cp "$IN/outputs.tar.gz" "$S/outputs.tar.gz" && chmod 644 "$S/outputs.tar.gz" || die "copy outputs"',
    '  mkdir "$S/frozen.x" && chown "$U" "$S/frozen.x" && chmod 700 "$S/frozen.x" || die "mkdir frozen"',
    `  if (cd "$S/frozen.x" && ${ctx.sandbox.runAs()} timeout -k 5 600 tar -xzf "$S/outputs.tar.gz" --no-same-owner --no-same-permissions) >"$S/logs/extract.log" 2>&1; then frozen=ok; else frozen=invalid; fi`,
    ctx.sandbox.killAll(),
    '  find "$S/frozen.x" -mindepth 1 ! -type f ! -type d ! -type l -delete 2>/dev/null',
    // A symlink that resolves outside the outputs (to the kit's reference, /etc, ...) is dropped.
    '  find "$S/frozen.x" -type l -print0 | while IFS= read -r -d "" l; do',
    '    r="$(realpath -m -- "$l")"; case "$r" in "$S/frozen.x"/*) ;; *) rm -f -- "$l" ;; esac',
    "  done",
    '  chown -R -h 0:0 "$S/frozen.x"; chmod -R u=rwX,go=rX "$S/frozen.x"; chmod -R a-w "$S/frozen.x"; chmod 755 "$S/frozen.x"; chmod a-w "$S/frozen.x"',
    '  if [ "$frozen" = ok ]; then mv "$S/frozen.x" "$S/frozen"; else rm -rf "$S/frozen.x"; fi',
    "fi",
    'rm -rf "$IN"',
    'echo "AB_SETUP frozen=$frozen sha256=$sha"',
  ].join("\n");
}

function killScript(ctx: ScriptCtx): string {
  return [PRELUDE, ctx.sandbox.killAll(), "exit 0"].join("\n");
}

/**
 * One gate, run detached as root. Writes `$S/status/<gate>.json` last (atomically):
 * `{"rc":N,"duration_ms":N,"verdict":"present|missing|...","alive_check":N,"alive_run":N}` and,
 * when present, the verdict copy `$S/status/<gate>.verdict`. `alive_*` count the sandbox uids'
 * processes (zombies aside) still running when the check exited; they are killed only after.
 *
 * Layout for one gate (W = $S/work/<gate>):
 *   W            check uid, 0711   (contender uid can traverse to run/, see nothing else)
 *   W/out        check uid, 0700   the check's private writable copy (its $1)
 *   W/home       check uid, 0700   the check's HOME
 *   W/run        dirs check uid:run gid 1775 (sticky), files run uid: $AB_RUN_DIR, the copy
 *                contender code may write; files the check adds there are read-only to it
 *   W/runhome    run uid, 0700     $AB_RUN_HOME
 *   $S/verdict/<gate>  check uid, 0700  the verdict dir (its $3 is gate.json in here)
 */
function gateScript(ctx: ScriptCtx, gate: Gate, workloadId: string, trialId: string): string {
  const U = ctx.sandbox.user;
  const RU = ctx.sandbox.runUser ?? "";
  const timeoutS = gate.timeout_s ?? DEFAULT_GATE_TIMEOUT_S;
  return [
    PRELUDE,
    `S=${sq(SCORE_ROOT)}; U=${sq(U)}; RU=${sq(RU)}; G=${sq(gate.id)}; WL=${sq(workloadId)}; TR=${sq(trialId)}`,
    `CHECK=${sq(gateCheckPath(gate))}; T=${timeoutS}; MAX=${GATE_VERDICT_MAX_BYTES}`,
    'W="$S/work/$G"; V="$S/verdict/$G"; ST="$S/status/$G"; LOG="$S/logs/$G.log"',
    'rm -rf "$W" "$V" "$ST.json" "$ST.verdict" "$ST.log"',
    'mkdir -p "$W/home" "$V"',
    // The check gets a private writable copy; the pristine frozen copy stays read-only.
    'if [ -d "$S/frozen" ]; then cp -a "$S/frozen" "$W/out"; chmod -R u+w "$W/out"; else mkdir "$W/out"; fi',
    'chown -R -h "$U" "$W/out" "$W/home"; chown "$U" "$W" "$V"; chmod 711 "$W"; chmod 700 "$W/out" "$W/home" "$V"',
    "RUNENV=()",
    'if [ -n "$RU" ]; then',
    '  if [ -d "$S/frozen" ]; then cp -a "$S/frozen" "$W/run"; else mkdir "$W/run"; fi',
    '  chown -R -h "$RU:$RU" "$W/run"; chmod -R u+w "$W/run"',
    '  find "$W/run" -type d -exec chown "$U:$RU" {} + -exec chmod 1775 {} +',
    '  mkdir -p "$W/runhome" && chown "$RU:$RU" "$W/runhome" && chmod 700 "$W/runhome"',
    '  RUNENV=(AB_RUN="$S/run-bin/ab-run" AB_RUN_DIR="$W/run" AB_RUN_HOME="$W/runhome")',
    "fi",
    "t0=$(date +%s%N)",
    'cd "$S/kit"',
    "(",
    "  ulimit -u 4096 2>/dev/null",
    `  exec timeout -k 10 "$T" ${ctx.sandbox.runAs()} env -i PATH=${CHECK_PATH_ENV} HOME="$W/home" TMPDIR="$W/home" LC_ALL=C LANG=C \\`,
    '    AB_GATE_ID="$G" AB_WORKLOAD_ID="$WL" AB_TRIAL_ID="$TR" AB_FROZEN="$S/frozen" AB_KIT="$S/kit" "${RUNENV[@]}" \\',
    '    bash "$S/kit/$CHECK" "$W/out" "$WL" "$V/gate.json"',
    ') </dev/null >"$LOG" 2>&1',
    "rc=$?",
    // Anything of either uid still running now is a fail (counted before it is killed).
    'count() { local n=0 d st; for d in /proc/[0-9]*; do [ "$(stat -c %u "$d" 2>/dev/null)" = "$1" ] || continue;',
    '  st="$(awk \'/^State:/{print $2; exit}\' "$d/status" 2>/dev/null)"; case "$st" in ""|Z|X) ;; *) n=$((n + 1)) ;; esac; done; echo "$n"; }',
    'alive_check="$(count "$(id -u "$U")")"',
    'alive_run=0; if [ -n "$RU" ]; then alive_run="$(count "$(id -u "$RU")")"; fi',
    ctx.sandbox.killAll(),
    "t1=$(date +%s%N)",
    'f="$V/gate.json"; verdict=missing',
    'if [ -L "$f" ]; then verdict=symlink',
    'elif [ -e "$f" ]; then',
    '  if [ ! -f "$f" ]; then verdict=not_regular',
    '  elif [ "$(stat -c %h "$f")" != 1 ]; then verdict=hardlink',
    '  elif [ "$(stat -c %U "$f")" != "$U" ]; then verdict=bad_owner',
    '  elif [ "$(stat -c %s "$f")" -gt "$MAX" ]; then verdict=too_large',
    '  else cp "$f" "$ST.verdict.tmp" && mv "$ST.verdict.tmp" "$ST.verdict" && verdict=present; fi',
    "fi",
    `tail -c ${LOG_TAIL_MAX_CHARS} "$LOG" > "$ST.log" 2>/dev/null`,
    'printf \'{"rc":%d,"duration_ms":%d,"verdict":"%s","alive_check":%d,"alive_run":%d}\\n\' "$rc" "$(( (t1 - t0) / 1000000 ))" "$verdict" "$alive_check" "$alive_run" > "$ST.json.tmp"',
    'mv "$ST.json.tmp" "$ST.json"',
  ].join("\n");
}

/** Read a root-only file on the scoring computer (exit 1 when it does not exist). */
function rootCat(path: string): string {
  const f = sq(path);
  return `if [ "$(id -u)" -eq 0 ]; then cat ${f} 2>/dev/null; else sudo -n cat ${f} 2>/dev/null; fi`;
}

// ---------------------------------------------------------------------------------------------
// Verdict normalization (fail closed)

const GateStatusFileSchema = z.object({
  rc: z.int(),
  duration_ms: z.int().nonnegative(),
  verdict: z.enum([
    "present",
    "missing",
    "symlink",
    "not_regular",
    "hardlink",
    "bad_owner",
    "too_large",
  ]),
  /** Processes of the check uid / contender uid still alive when the check exited. */
  alive_check: z.int().nonnegative().default(0),
  alive_run: z.int().nonnegative().default(0),
});

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function safeEvidence(paths: readonly string[]): string[] {
  const ok = paths.filter(
    (p) =>
      p.length > 0 &&
      p.length <= 512 &&
      !p.startsWith("/") &&
      !p.startsWith("~") &&
      !p.includes("\\") &&
      !p.split("/").includes(".."),
  );
  return [...new Set(ok)].slice(0, EVIDENCE_MAX);
}

function failOutcome(
  status: Exclude<GateOutcomeStatus, "verdict">,
  reason: string,
  extra: Partial<
    Pick<GateOutcome, "exit_code" | "timed_out" | "duration_ms" | "log_tail" | "kit_fault">
  > = {},
): GateOutcome {
  return {
    kit_fault: extra.kit_fault ?? false,
    result: { pass: false, applicable: true, reason: clip(reason, REASON_MAX_CHARS), evidence: [] },
    status,
    exit_code: extra.exit_code ?? null,
    timed_out: extra.timed_out ?? false,
    duration_ms: extra.duration_ms ?? 0,
    log_tail: extra.log_tail ?? "",
  };
}

/**
 * Turn what the scoring computer reported into an outcome. Exported for tests. Every path that is
 * not "exit 0 with a valid gate.json" is a FAIL.
 */
export function normalizeVerdict(input: {
  gateId: string;
  timeoutS: number;
  status: z.input<typeof GateStatusFileSchema> | null;
  verdictText: string | null;
  logTail: string;
}): GateOutcome {
  const { status, logTail } = input;
  if (!status) {
    return failOutcome(
      "timeout",
      `gate ${input.gateId}: no result from the scoring computer within ${input.timeoutS}s (fail closed)`,
      { timed_out: true, log_tail: logTail, kit_fault: true },
    );
  }
  const base = { exit_code: status.rc, duration_ms: status.duration_ms, log_tail: logTail };
  // coreutils timeout: 124 on TERM, 137 after the -k KILL.
  if (status.rc === 124 || status.rc === 137) {
    return failOutcome(
      "timeout",
      `gate ${input.gateId}: check timed out after ${input.timeoutS}s (fail closed)`,
      { ...base, timed_out: true },
    );
  }
  const aliveRun = status.alive_run ?? 0;
  const aliveCheck = status.alive_check ?? 0;
  if (aliveRun > 0 || aliveCheck > 0) {
    const who =
      aliveRun > 0
        ? `${aliveRun} contender process(es)`
        : `${aliveCheck} process(es) of the check itself`;
    return failOutcome(
      "lingering",
      `gate ${input.gateId}: ${who} still running when the check exited (fail closed)`,
      { ...base, kit_fault: aliveRun === 0 },
    );
  }
  if (status.rc !== 0) {
    const wrote = status.verdict === "present";
    return failOutcome(
      "check_failed",
      `gate ${input.gateId}: check exited ${status.rc} (fail closed${wrote ? "; its gate.json is ignored" : "; no verdict: a broken check"})`,
      { ...base, kit_fault: !wrote },
    );
  }
  if (status.verdict !== "present" || input.verdictText === null) {
    const why: Record<string, string> = {
      missing: "wrote no gate.json",
      symlink: "gate.json is a symlink",
      not_regular: "gate.json is not a regular file",
      hardlink: "gate.json has more than one link",
      bad_owner: "gate.json is not owned by the check's user",
      too_large: `gate.json is larger than ${GATE_VERDICT_MAX_BYTES} bytes`,
      present: "gate.json could not be read back",
    };
    return failOutcome(
      "no_verdict",
      `gate ${input.gateId}: ${why[status.verdict] ?? "no verdict"} (fail closed)`,
      { ...base, kit_fault: true },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.verdictText);
  } catch (e) {
    return failOutcome(
      "invalid_verdict",
      `gate ${input.gateId}: gate.json is not JSON (${(e as Error).message}) (fail closed)`,
      { ...base, kit_fault: true },
    );
  }
  const parsed = GateResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return failOutcome(
      "invalid_verdict",
      `gate ${input.gateId}: gate.json is invalid: ${issues} (fail closed)`,
      { ...base, kit_fault: true },
    );
  }
  const r = parsed.data;
  const applicable = r.applicable ?? true;
  return {
    result: {
      // A not-applicable gate never vouches for a number.
      pass: applicable && r.pass,
      applicable,
      reason: clip(r.reason, REASON_MAX_CHARS),
      evidence: safeEvidence(r.evidence),
    },
    status: "verdict",
    ...base,
    timed_out: false,
    kit_fault: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Runner

export interface GateRunLogger {
  info?(obj: object, msg: string): void;
  warn?(obj: object, msg: string): void;
}

export interface GateRunDeps {
  /** The registry over the scoring provider: every scoring computer gets a `computers` row. */
  registry: ComputerRegistry;
  sandbox?: GateSandbox;
  /** Status poll interval while a gate runs. Default 2000 ms. */
  pollIntervalMs?: number;
  /** waitReady timeout for the scoring computer. Default 600 000 ms. */
  readyTimeoutMs?: number;
  /** Extra wait past a gate's timeout (which has a 10 s KILL grace) before it is declared lost. Default 100 000 ms. */
  graceMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger?: GateRunLogger;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Score one trial on a fresh scoring computer. See the file header for the guarantees. */
export async function runGates(
  rawInput: GateRunInput,
  deps: GateRunDeps,
): Promise<TrialGateRecord> {
  const input = GateRunInputSchema.parse(rawInput);
  const sandbox = deps.sandbox ?? uidGateSandbox();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const pollMs = deps.pollIntervalMs ?? 2000;
  const graceMs = deps.graceMs ?? 100_000;
  const { registry } = deps;
  const provider = registry.provider;

  // ---- kit checks before any spend
  const ids = new Set<string>();
  for (const g of input.gates) {
    if (ids.has(g.id)) throw new GateKitError(`gate ${g.id} is listed twice`);
    ids.add(g.id);
  }
  const roots = allowedRoots(input.gates);
  const bundlePaths = new Set<string>();
  for (const f of input.scoring) {
    if (!underRoot(f.path, roots)) {
      throw new GateKitError(
        `scoring bundle may only hold ${roots.join(", ")}; refusing ${f.path} (the subject's files never reach the scoring computer)`,
      );
    }
    bundlePaths.add(f.path);
  }
  for (const g of input.gates) {
    if (!bundlePaths.has(gateCheckPath(g))) {
      throw new GateKitError(`gate ${g.id}: ${gateCheckPath(g)} is not in the scoring bundle`);
    }
  }
  if (
    input.profile.snapshotId !== undefined &&
    input.subjectSnapshotIds.includes(input.profile.snapshotId)
  ) {
    throw new GateKitError(
      `scoring snapshot ${input.profile.snapshotId} held a subject; the scoring computer must never contain the subject`,
    );
  }

  const record = (
    gates: Record<string, GateOutcome>,
    computer: TrialGateRecord["scoring_computer"],
    sha: string | null,
  ): TrialGateRecord =>
    TrialGateRecordSchema.parse({
      version: 1,
      trial_id: input.trialId,
      workload_id: input.workloadId,
      scored_at: now().toISOString(),
      scoring_computer: computer,
      sandbox: sandbox.level,
      outputs_sha256: sha,
      gates,
    });

  const allFail = (reason: string): Record<string, GateOutcome> =>
    Object.fromEntries(
      input.gates.map((g) => [g.id, failOutcome("no_outputs", `gate ${g.id}: ${reason}`)]),
    );

  // ---- nothing to score: no computer
  if (input.gates.length === 0) return record({}, null, null);

  // ---- no outputs: fail closed without spending a computer
  if (input.frozen.kind === "missing") {
    return record(allFail(`no frozen outputs (${input.frozen.reason}) (fail closed)`), null, null);
  }

  // ---- fresh scoring computer
  const spec = {
    name: `ab-score-${input.trialId}`.slice(0, 200),
    vcpu: input.profile.vcpu,
    memoryMb: input.profile.memoryMb,
    diskGb: input.profile.diskGb,
    ...(input.profile.snapshotId !== undefined ? { snapshotId: input.profile.snapshotId } : {}),
  };
  let computerId: string;
  let info: ComputerInfo;
  try {
    const reg = await registry.create({ runId: input.runId, trialId: input.trialId, spec });
    computerId = reg.computerId;
    info = reg.info;
  } catch (err) {
    throw new GateInfraError(`scoring computer could not be created: ${String(err)}`, {
      cause: err,
    });
  }
  let destroyed = false;
  try {
    try {
      info = await registry.waitReady(computerId, {
        timeoutMs: deps.readyTimeoutMs ?? 600_000,
        intervalMs: Math.max(100, Math.min(pollMs, 2000)),
      });
    } catch (err) {
      throw new GateInfraError(`scoring computer never became ready: ${String(err)}`, {
        cause: err,
      });
    }
    const id = info.id;
    const ctx: ScriptCtx = { home: info.home, sandbox };
    const IN = SCORE_INBOX;
    const execCap = provider.capabilities.maxExecTimeoutMs;
    const exec = async (command: string, timeoutMs: number) => {
      const r = await provider.exec(id, command, { timeoutMs: Math.min(timeoutMs, execCap) });
      await registry.touch(computerId).catch(() => undefined);
      return r;
    };

    // ---- put the scoring bundle and scripts (putFile: never on a command line)
    for (const f of input.scoring) {
      await provider.putFile(id, posix.join(IN, "kit", f.path), f.data, { mode: 0o644 });
    }
    for (const g of input.gates) {
      await provider.putFile(
        id,
        posix.join(IN, `gate-${g.id}.sh`),
        gateScript(ctx, g, input.workloadId, input.trialId),
        { mode: 0o700 },
      );
    }
    await provider.putFile(id, posix.join(IN, "kill.sh"), killScript(ctx), { mode: 0o700 });

    // ---- frozen outputs
    let expectSha: string | null = null;
    if (input.frozen.kind === "url") {
      expectSha = input.frozen.sha256;
      await provider.putFile(id, posix.join(IN, "fetch.url"), `${input.frozen.url}\n`, {
        mode: 0o600,
      });
      await provider.putFile(id, posix.join(IN, "fetch.sh"), fetchScript(ctx), { mode: 0o700 });
      const r = await exec(`bash ${sq(posix.join(info.home, IN, "fetch.sh"))}`, 900_000);
      if (r.exitCode !== 0) {
        throw new GateInfraError(
          `download of the frozen outputs failed (exit ${r.exitCode}): ${clip(r.stderr.trim(), 500)}`,
        );
      }
    } else {
      expectSha = input.frozen.sha256 ?? null;
      await provider.putFile(id, posix.join(IN, "outputs.tar.gz"), input.frozen.data, {
        mode: 0o644,
      });
    }
    await provider.putFile(id, posix.join(IN, "setup.sh"), setupScript(ctx, expectSha), {
      mode: 0o700,
    });
    const setup = await exec(`bash ${sq(posix.join(info.home, IN, "setup.sh"))}`, 900_000);
    const line = setup.stdout
      .trim()
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("AB_SETUP"));
    const m = line
      ? /^AB_SETUP frozen=(ok|missing|invalid) sha256=([0-9a-f]{64}|-)$/.exec(line)
      : null;
    if (setup.exitCode !== 0 || !m) {
      throw new GateInfraError(
        `scoring setup failed (exit ${setup.exitCode}): ${clip(`${line ?? ""} ${setup.stderr}`.trim(), 500)}`,
      );
    }
    const frozenState = m[1]!;
    const sha = m[2] === "-" ? null : m[2]!;
    const scoredOn = () => ({
      provider: provider.name,
      computer_id: computerId,
      provider_id: id,
      snapshot_id: info.snapshotId,
      destroyed,
    });

    if (frozenState !== "ok") {
      const why =
        frozenState === "invalid"
          ? "the frozen outputs could not be unpacked (fail closed)"
          : "no frozen outputs reached the scoring computer (fail closed)";
      destroyed = await destroyQuietly(registry, computerId, deps.logger);
      return record(allFail(why), scoredOn(), sha);
    }

    // ---- gates, one at a time (they share the sandbox uid; killAll runs between them)
    const outcomes: Record<string, GateOutcome> = {};
    for (const g of input.gates) {
      const timeoutS = g.timeout_s ?? DEFAULT_GATE_TIMEOUT_S;
      await provider.execDetached(id, asRoot(`${SCORE_ROOT}/bin/gate-${g.id}.sh`), {
        logPath: posix.join(info.home, ".anybench", "logs", `gate-${g.id}.log`),
      });
      const statusPath = `${SCORE_ROOT}/status/${g.id}.json`;
      const deadline = Date.now() + timeoutS * 1000 + graceMs;
      let status: z.infer<typeof GateStatusFileSchema> | null = null;
      for (;;) {
        const r = await exec(rootCat(statusPath), 30_000);
        if (r.exitCode === 0 && r.stdout.trim() !== "") {
          const p = GateStatusFileSchema.safeParse(safeJson(r.stdout.trim()));
          if (!p.success) throw new GateInfraError(`gate ${g.id}: unreadable status file`);
          status = p.data;
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(pollMs);
      }
      if (!status) {
        await exec(asRoot(`${SCORE_ROOT}/bin/kill.sh`), 60_000).catch(() => undefined);
      }
      let verdictText: string | null = null;
      if (status?.verdict === "present") {
        const v = await exec(rootCat(`${SCORE_ROOT}/status/${g.id}.verdict`), 30_000);
        verdictText = v.exitCode === 0 && !v.truncated ? v.stdout : null;
      }
      const tail = await exec(rootCat(`${SCORE_ROOT}/status/${g.id}.log`), 30_000);
      outcomes[g.id] = normalizeVerdict({
        gateId: g.id,
        timeoutS,
        status,
        verdictText,
        logTail: tail.exitCode === 0 ? clip(tail.stdout, LOG_TAIL_MAX_CHARS) : "",
      });
      deps.logger?.info?.(
        {
          trialId: input.trialId,
          gate: g.id,
          pass: outcomes[g.id]!.result.pass,
          status: outcomes[g.id]!.status,
        },
        "gate scored",
      );
    }

    destroyed = await destroyQuietly(registry, computerId, deps.logger);
    return record(outcomes, scoredOn(), sha);
  } finally {
    if (!destroyed) await destroyQuietly(registry, computerId, deps.logger);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Destroy; on failure flag it leaked (the reaper retries) and carry on. */
async function destroyQuietly(
  registry: ComputerRegistry,
  computerId: string,
  logger?: GateRunLogger,
): Promise<boolean> {
  try {
    await registry.destroy(computerId);
    return true;
  } catch (err) {
    logger?.warn?.({ err, computerId }, "scoring computer destroy failed; flagged leaked");
    await registry.markLeaked(computerId).catch(() => undefined);
    return false;
  }
}
