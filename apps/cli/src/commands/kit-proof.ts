// `anybench kit proof [dir]` (TDM-219 [19.3]): the oracle and do-nothing checks, locally in
// Docker, the way kits/tandem-vs-claude-code/scripts/verify-proof.sh does it for that kit. The
// logic is @anybench/kit runLocalProof.
//
// Exit codes: 0 both checks pass · 1 a check failed, or the kit is invalid · 2 usage ·
// 3 the proof could not run (no Docker, no locally runnable oracle, docker failed, timeout).
import { DEFAULT_LOCAL_PROOF_IMAGE, runLocalProof, type LocalProofResult } from "@anybench/kit";
import { defaultIo, parseFlags, type CliIo } from "./args.js";

export const KIT_PROOF_USAGE = `Usage: anybench kit proof [dir] [--image <image>] [--network] [--timeout <s>] [--keep] [--json]

Run the kit's oracle and a do-nothing contender on every workload, locally in Docker
(docker run --network none, the kit mounted read-only; the gates run in a second container
that never held the contender). Passes when the oracle passes every gate it covers and the
untouched starting workspace fails a gate, on every workload. No agent, no model tokens.
Anybench reruns the full proof on its own computers when you push the kit.

Options:
  --image <image>  container image (default $ANYBENCH_PROOF_IMAGE or ${DEFAULT_LOCAL_PROOF_IMAGE})
  --network        give the containers a network (default: none)
  --timeout <s>    overall cap in seconds (default 1800)
  --keep           keep the records directory and print its path
  --json           print the full result as JSON
  -h, --help

Exit codes: 0 pass · 1 fail or invalid kit · 2 usage · 3 could not run.`;

export interface KitProofDeps {
  env?: NodeJS.ProcessEnv;
  /** Tests stub the proof run. */
  runLocalProof?: typeof runLocalProof;
}

export function kitProofExitCode(r: LocalProofResult): number {
  if (r.status === "pass") return 0;
  if (r.status === "fail" || r.error?.code === "invalid_kit") return 1;
  return 3;
}

export function formatLocalProof(r: LocalProofResult): string[] {
  const lines: string[] = [];
  if (r.error) {
    lines.push(`error (${r.error.code}): ${r.error.message}`);
    for (const i of r.error.issues) lines.push(`  ${i}`);
    return lines;
  }
  for (const c of r.checks) {
    lines.push(`${c.pass ? "PASS" : "FAIL"} ${c.check}: ${c.reason}`);
    for (const u of c.units) {
      lines.push(`  ${u.ok ? "ok  " : "FAIL"} ${u.reason}`);
      for (const g of u.gates)
        lines.push(`         ${g.gateId}: ${g.status}: ${g.reason.split("\n")[0]}`);
      if (!u.ok && u.log.trim() !== "") {
        lines.push("         log tail:");
        for (const l of u.log.trimEnd().split("\n").slice(-15)) lines.push(`           ${l}`);
      }
      for (const g of u.gates) {
        if (g.status === "no_verdict" && g.log.trim() !== "") {
          lines.push(`         ${g.gateId} check.sh output:`);
          for (const l of g.log.trimEnd().split("\n").slice(-15)) lines.push(`           ${l}`);
        }
      }
    }
  }
  lines.push(
    `RESULT: ${r.status.toUpperCase()} (${r.image}, ${(r.durationMs / 1000).toFixed(1)} s)${r.outDir ? `; records kept at ${r.outDir}` : ""}`,
  );
  return lines;
}

export async function runKitProof(
  argv: readonly string[],
  io: CliIo = defaultIo,
  deps: KitProofDeps = {},
): Promise<number> {
  const a = parseFlags(argv, {
    booleans: ["network", "keep", "json"],
    strings: ["image", "timeout"],
  });
  if ("error" in a) {
    io.stderr(`anybench kit proof: ${a.error}`);
    io.stderr(KIT_PROOF_USAGE);
    return 2;
  }
  if (a.booleans.has("help")) {
    io.stdout(KIT_PROOF_USAGE);
    return 0;
  }
  let timeoutMs: number | undefined;
  const t = a.strings.get("timeout");
  if (t !== undefined) {
    if (!/^[1-9]\d*$/.test(t)) {
      io.stderr(`anybench kit proof: --timeout must be a whole number of seconds, not '${t}'`);
      return 2;
    }
    timeoutMs = Number(t) * 1000;
  }
  const env = deps.env ?? process.env;
  const image = a.strings.get("image") ?? (env.ANYBENCH_PROOF_IMAGE || DEFAULT_LOCAL_PROOF_IMAGE);
  const json = a.booleans.has("json");
  const run = deps.runLocalProof ?? runLocalProof;
  const r = await run(a.positionals[0] ?? ".", {
    image,
    network: a.booleans.has("network"),
    keep: a.booleans.has("keep"),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    // Progress goes to stderr, so --json keeps stdout parseable.
    onLog: (l) => io.stderr(l),
  });
  if (json) io.stdout(JSON.stringify(r, null, 2));
  else for (const l of formatLocalProof(r)) (r.ok ? io.stdout : io.stderr)(l);
  return kitProofExitCode(r);
}
