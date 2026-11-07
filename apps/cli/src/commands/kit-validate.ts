// `anybench kit validate [dir]` (TDM-33 [4.1]). Self-contained: TDM-107 builds the full CLI around it.
//
// Exit codes: 0 valid · 1 the kit has errors · 2 usage error.
import { formatKitIssue, validateKitDir } from "@anybench/kit";

export interface KitValidateIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIo: KitValidateIo = {
  stdout: (l) => process.stdout.write(`${l}\n`),
  stderr: (l) => process.stderr.write(`${l}\n`),
};

export const KIT_VALIDATE_USAGE = `Usage: anybench kit validate [dir] [--json] [--quiet]

Validate the eval kit in [dir] (default: .): anybench.yaml against KitSpec v2, every file it
references (adapters/, workloads/, gates/, reference/, proof/, rubric.md), and the workload hashes.

Options:
  --json    print the full result as JSON
  --quiet   print errors only (no summary, no warnings)
  -h, --help`;

export interface KitValidateArgs {
  dir: string;
  json: boolean;
  quiet: boolean;
  help: boolean;
}

/** Minimal parser: one optional positional, three flags. */
export function parseKitValidateArgs(argv: readonly string[]): KitValidateArgs | { error: string } {
  const out: KitValidateArgs = { dir: ".", json: false, quiet: false, help: false };
  let positional: string | undefined;
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a === "--quiet" || a === "-q") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) return { error: `unknown option: ${a}` };
    else if (positional !== undefined) return { error: `unexpected argument: ${a}` };
    else positional = a;
  }
  if (positional !== undefined) out.dir = positional;
  return out;
}

export async function runKitValidate(
  argv: readonly string[],
  io: KitValidateIo = defaultIo,
): Promise<number> {
  const args = parseKitValidateArgs(argv);
  if ("error" in args) {
    io.stderr(`anybench kit validate: ${args.error}`);
    io.stderr(KIT_VALIDATE_USAGE);
    return 2;
  }
  if (args.help) {
    io.stdout(KIT_VALIDATE_USAGE);
    return 0;
  }

  const r = await validateKitDir(args.dir);

  if (args.json) {
    const { kit, ...rest } = r;
    const summary = kit && {
      subject: kit.spec.subject.name,
      contenders: kit.contenders,
      gates: kit.gates,
      workloads: kit.workloads.map((w) => ({ id: w.id, sha256: w.sha256, files: w.files })),
    };
    io.stdout(JSON.stringify({ ...rest, ...(summary ? { kit: summary } : {}) }, null, 2));
    return r.ok ? 0 : 1;
  }

  for (const line of r.lines) io.stderr(line);
  if (!args.quiet) for (const w of r.warnings) io.stderr(`warning: ${formatKitIssue(w)}`);

  if (!r.ok || r.kit === undefined) {
    io.stderr(`${r.errors.length} error${r.errors.length === 1 ? "" : "s"} in ${r.dir}`);
    return 1;
  }
  if (!args.quiet) {
    const { spec, workloads } = r.kit;
    io.stdout(
      `ok ${r.dir}: ${spec.subject.name} (${spec.contenders.length} contenders, ${spec.workloads.length} workloads, ${spec.gates.length} gates, ${spec.requirements.length} requirements)`,
    );
    for (const w of workloads)
      io.stdout(`  workload ${w.id}  sha256 ${w.sha256}  ${w.files.length} file(s)`);
  }
  return 0;
}
