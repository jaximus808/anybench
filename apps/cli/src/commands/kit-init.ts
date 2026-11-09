// `anybench kit init [dir]` (TDM-219 [19.3]): scaffold a KitSpec v2 kit folder from one of the
// shipped examples, then validate it. The logic is @anybench/kit scaffoldKit.
//
// Exit codes: 0 scaffolded and valid · 1 scaffolded but invalid, or refused (non-empty dir) · 2 usage.
import {
  DEFAULT_KIT_TEMPLATE,
  KIT_TEMPLATES,
  KIT_TEMPLATE_SUMMARIES,
  KitScaffoldError,
  formatKitIssue,
  isKitTemplate,
  scaffoldKit,
  validateKitDir,
} from "@anybench/kit";
import { defaultIo, parseFlags, type CliIo } from "./args.js";

export const KIT_INIT_USAGE = `Usage: anybench kit init [dir] [--template <name>] [--force] [--json]

Scaffold a new eval kit in [dir] (default: .): anybench.yaml (KitSpec v2), adapters/,
workloads/<id>/{instruction.md,input/,setup.sh}, gates/, proof/{oracle,do_less,regression}/.

Templates:
${KIT_TEMPLATES.map((t) => `  ${t.padEnd(13)}${KIT_TEMPLATE_SUMMARIES[t]}${t === DEFAULT_KIT_TEMPLATE ? " (default)" : ""}`).join("\n")}

Options:
  --template <name>  which example to start from (default ${DEFAULT_KIT_TEMPLATE})
  --force            write into a non-empty directory
  --json             print the result as JSON
  -h, --help`;

export async function runKitInit(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const a = parseFlags(argv, { booleans: ["force", "json"], strings: ["template"] });
  if ("error" in a) {
    io.stderr(`anybench kit init: ${a.error}`);
    io.stderr(KIT_INIT_USAGE);
    return 2;
  }
  if (a.booleans.has("help")) {
    io.stdout(KIT_INIT_USAGE);
    return 0;
  }
  const template = a.strings.get("template") ?? DEFAULT_KIT_TEMPLATE;
  if (!isKitTemplate(template)) {
    io.stderr(
      `anybench kit init: unknown template '${template}' (one of ${KIT_TEMPLATES.join(", ")})`,
    );
    return 2;
  }
  const dir = a.positionals[0] ?? ".";
  let files: string[];
  let abs: string;
  try {
    const r = await scaffoldKit(dir, { template, force: a.booleans.has("force") });
    files = r.files;
    abs = r.dir;
  } catch (e) {
    if (e instanceof KitScaffoldError) {
      io.stderr(`anybench kit init: ${e.message}`);
      return 1;
    }
    throw e;
  }
  const v = await validateKitDir(abs);
  if (a.booleans.has("json")) {
    io.stdout(
      JSON.stringify(
        { ok: v.ok, dir: abs, template, files, errors: v.errors.map(formatKitIssue) },
        null,
        2,
      ),
    );
    return v.ok ? 0 : 1;
  }
  if (!v.ok) {
    for (const l of v.lines) io.stderr(l);
    io.stderr(`scaffolded ${abs}, but it does not validate (${v.errors.length} errors)`);
    return 1;
  }
  io.stdout(`created ${abs} from the ${template} template (${files.length} files); it validates.`);
  io.stdout("Next:");
  io.stdout(`  edit anybench.yaml, workloads/, gates/ and proof/ into your own benchmark`);
  io.stdout(`  anybench kit validate ${dir}`);
  io.stdout(`  anybench kit proof ${dir}     # oracle + do-nothing, locally in Docker`);
  io.stdout(`  anybench kit push ${dir}      # upload; Anybench reruns the proof on its computers`);
  return 0;
}
