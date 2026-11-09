// TDM-219 [19.3]: runLocalProof, the generalised kits/tandem-vs-claude-code/scripts/verify-proof.sh.
//
//   const r = await runLocalProof("my-kit");          // LocalProofResult, never throws for the kit
//   r.ok        both checks passed on every workload
//   r.status    pass | fail | error (error: it could not run; r.error.code says why)
//
// Two `docker run --rm --network none` containers (default image node:22), each with a random
// name so parallel runs never collide: the subject side gets the kit without gates/ and
// reference/; the scoring side gets only gates/ and reference/ (script.ts). Records go to a temp
// dir, are judged by evaluateLocalProof, and the temp dir is removed unless `keep`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dockerLocalAvailable } from "@anybench/providers";
import { formatKitIssue } from "../issues.js";
import { KIT_LAYOUT } from "../layout.js";
import { validateKitDir } from "../validate.js";
import {
  evaluateLocalProof,
  readLocalProofRecords,
  type LocalProofErrorCode,
  type LocalProofResult,
} from "./evaluate.js";
import { LocalProofError, planLocalProof, type LocalProofPlan } from "./plan.js";
import { renderLocalProofGateScript, renderLocalProofTrialScript } from "./script.js";

export const DEFAULT_LOCAL_PROOF_IMAGE = "node:22";
export const DEFAULT_LOCAL_PROOF_TIMEOUT_MS = 30 * 60_000;

export interface RunLocalProofOptions {
  /** Docker image both containers run. Default node:22. */
  image?: string;
  /** Give the containers a network (default: --network none, as the proof needs none). */
  network?: boolean;
  /** Overall wall-clock cap across both containers. Default 30 min. */
  timeoutMs?: number;
  /** Keep the records dir (its path is `outDir` in the result). */
  keep?: boolean;
  /** Progress lines from the containers (`[proof] oracle slugify: gate hidden-tests`). */
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  /** The docker binary. Default `docker`. */
  dockerBin?: string;
}

interface DockerExit {
  code: number | null;
  timedOut: boolean;
  stderr: string;
}

function runContainer(
  bin: string,
  args: string[],
  onLine: (l: string) => void,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<DockerExit> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    let stderr = "";
    let buf = "";
    const name = args[args.indexOf("--name") + 1]!;
    const kill = () => {
      spawn(bin, ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {});
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-8000);
    });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (buf !== "") onLine(buf);
      resolve({ code, timedOut, stderr });
    };
    child.on("error", (e) => {
      stderr += String(e);
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/** Copy the kit into a staging dir: `subject` = all but gates/ and reference/; `scoring` = those. */
async function stage(
  kitDir: string,
  dest: string,
  side: "subject" | "scoring",
  plan: LocalProofPlan,
) {
  const scoringTop = new Set<string>([KIT_LAYOUT.gatesDir, KIT_LAYOUT.referenceDir]);
  for (const g of plan.gates) if (g.reference) scoringTop.add(g.reference.split("/")[0]!);
  await mkdir(dest, { recursive: true });
  await cp(kitDir, dest, {
    recursive: true,
    // Symlinks inside the kit are copied as what they point at (validateKitDir already refused
    // the ones that leave it), so the containers never follow a link out of the mount.
    dereference: true,
    filter: (from) => {
      const rel = path.relative(kitDir, from);
      if (rel === "") return true;
      const top = rel.split(path.sep)[0]!;
      if (top === ".git") return false;
      if (side === "scoring") return scoringTop.has(top);
      // The subject side never sees gates/ or reference/ (nor a gate reference elsewhere).
      return !scoringTop.has(top);
    },
  });
  if (side === "subject") {
    // The driver_patch replaces the contender's driver, as the server's proof runner does.
    const patched = path.join(dest, plan.oracle.driver);
    await mkdir(path.dirname(patched), { recursive: true });
    await cp(path.join(kitDir, plan.oracle.driverPatch), patched, { dereference: true });
    await chmod(patched, 0o755);
  }
}

/**
 * Run the oracle and do-nothing checks of the kit in `dir` locally in Docker. Validates the kit
 * first. Resolves to a LocalProofResult in every case the kit or the machine is at fault (invalid
 * kit, no runnable oracle, no Docker, a timeout); rejects only on a bug or an abort.
 */
export async function runLocalProof(
  dir: string,
  opts: RunLocalProofOptions = {},
): Promise<LocalProofResult> {
  const started = Date.now();
  const image = opts.image ?? DEFAULT_LOCAL_PROOF_IMAGE;
  const bin = opts.dockerBin ?? "docker";
  const log = opts.onLog ?? (() => {});
  const v = await validateKitDir(dir);
  const result = (
    status: LocalProofResult["status"],
    rest: Partial<LocalProofResult> = {},
  ): LocalProofResult => ({
    ok: status === "pass",
    status,
    error: null,
    dir: v.dir,
    image,
    checks: [],
    durationMs: Date.now() - started,
    outDir: null,
    ...rest,
  });
  const err = (code: LocalProofErrorCode, message: string, issues: string[] = []) =>
    result("error", { error: { code, message, issues } });

  if (!v.ok || v.kit === undefined) {
    return err(
      "invalid_kit",
      `${v.errors.length} error(s) in ${v.dir}`,
      v.errors.map(formatKitIssue),
    );
  }
  let plan: LocalProofPlan;
  try {
    plan = planLocalProof(v.kit);
  } catch (e) {
    if (e instanceof LocalProofError) return err(e.code, e.message);
    throw e;
  }
  if (!(await dockerLocalAvailable(bin))) {
    return err(
      "docker_unavailable",
      "no Docker daemon answered `docker info`; start Docker and retry",
    );
  }

  const work = await mkdtemp(path.join(tmpdir(), "anybench-kit-proof-"));
  const keep = opts.keep === true;
  try {
    const out = path.join(work, "out");
    await mkdir(out, { recursive: true });
    await stage(v.dir, path.join(work, "subject"), "subject", plan);
    await stage(v.dir, path.join(work, "scoring"), "scoring", plan);
    await writeFile(path.join(work, "trial.sh"), renderLocalProofTrialScript(plan), {
      mode: 0o755,
    });
    await writeFile(path.join(work, "gate.sh"), renderLocalProofGateScript(plan), { mode: 0o755 });

    const deadline = started + (opts.timeoutMs ?? DEFAULT_LOCAL_PROOF_TIMEOUT_MS);
    const ids =
      typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["-e", `HOST_UID=${process.getuid()}`, "-e", `HOST_GID=${process.getgid()}`]
        : [];
    for (const side of ["subject", "scoring"] as const) {
      const script = side === "subject" ? "trial.sh" : "gate.sh";
      const name = `anybench-kit-proof-${side}-${randomBytes(6).toString("hex")}`;
      const args = [
        "run",
        "--rm",
        "--name",
        name,
        ...(opts.network === true ? [] : ["--network", "none"]),
        "-v",
        `${path.join(work, side)}:/kit:ro`,
        "-v",
        `${out}:/out`,
        "-v",
        `${path.join(work, script)}:/proof.sh:ro`,
        ...ids,
        image,
        "bash",
        "/proof.sh",
      ];
      const left = deadline - Date.now();
      if (left <= 0) return err("timeout", "the local proof hit its overall timeout");
      const r = await runContainer(bin, args, log, left, opts.signal);
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      if (r.timedOut) return err("timeout", `the ${side} container hit the overall timeout`);
      // The scripts exit 0 even when a unit fails; a non-zero exit is docker or the script dying.
      if (r.code !== 0 || !existsSync(path.join(out, "units"))) {
        return err(
          "docker_failed",
          `docker run (${side}) exited ${r.code ?? "abnormally"}: ${r.stderr.trim().split("\n").slice(-5).join(" | ")}`,
        );
      }
    }

    const records = await readLocalProofRecords(out, plan);
    const checks = evaluateLocalProof(plan, records);
    const pass = checks.every((c) => c.pass);
    return result(pass ? "pass" : "fail", { checks, outDir: keep ? work : null });
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
