// TDM-219 [19.3]: `anybench kit init`. A new kit folder is a copy of one of the shipped examples
// (packages/kit/examples/<template>), which the kit tests keep valid, so a fresh scaffold always
// passes `validateKitDir` and, for templates with a standalone oracle, the local proof.
//
//   scaffoldKit(dir, { template: "coding-agent" })   → the KitSpec v2 folder at dir
//
// The CLI (`anybench kit init`) and the MCP server (TDM-220) both call this; nothing here prints.
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HASH_IGNORED_NAMES } from "./hash.js";
import { KIT_LAYOUT } from "./layout.js";

/** The templates `scaffoldKit` can copy, one per driver type. `coding-agent` is the default. */
export const KIT_TEMPLATES = ["coding-agent", "cli", "harness", "http-agent"] as const;
export type KitTemplate = (typeof KIT_TEMPLATES)[number];
export const DEFAULT_KIT_TEMPLATE: KitTemplate = "coding-agent";

/** What each template benchmarks, for `--help` and the MCP tool description. */
export const KIT_TEMPLATE_SUMMARIES: Readonly<Record<KitTemplate, string>> = {
  "coding-agent":
    "a headless coding agent (Claude Code) on a coding task graded by hidden tests; the oracle applies a reference solution, so the local proof runs with no agent and no network",
  cli: "a command-line tool (ripgrep vs GNU grep) graded against reference output",
  harness: "an agent harness (Tandem vs plain Claude Code) graded by hidden tests",
  "http-agent": "a chat agent behind an HTTP API graded on labeled conversations",
};

export class KitScaffoldError extends Error {
  override readonly name = "KitScaffoldError";
}

export interface ScaffoldKitOptions {
  /** Which example to start from. Default `coding-agent`. */
  template?: KitTemplate;
  /** Write into a non-empty directory (existing files with the same path are overwritten). */
  force?: boolean;
  /** Where the examples live. Default: this package's `examples/` (tests override it). */
  examplesDir?: string;
}

export interface ScaffoldKitResult {
  /** Absolute kit directory. */
  dir: string;
  template: KitTemplate;
  /** Kit-relative paths written, sorted. */
  files: string[];
}

/** packages/kit/examples, from both src/ (tests) and dist/ (the built CLI). */
export function defaultExamplesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
}

export function isKitTemplate(s: string): s is KitTemplate {
  return (KIT_TEMPLATES as readonly string[]).includes(s);
}

/** The header every scaffolded anybench.yaml starts with, in place of the example's own. */
export function scaffoldHeader(template: KitTemplate): string {
  return [
    `# Scaffolded by \`anybench kit init\` from the ${template} example (packages/kit/examples/${template}).`,
    "# Edit it into your own benchmark, then:",
    "#   anybench kit validate .   check anybench.yaml and every file it references",
    "#   anybench kit proof .      run the oracle and a do-nothing contender locally in Docker",
    "#   anybench kit push .       upload it; Anybench reruns the proof on its own computers",
    "",
  ].join("\n");
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(path.join(root, rel))).sort()) {
    if (HASH_IGNORED_NAMES.has(name)) continue;
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = await lstat(path.join(root, r));
    if (st.isDirectory()) out.push(...(await listFiles(root, r)));
    else out.push(r);
  }
  return out;
}

/**
 * Write a new KitSpec v2 kit folder at `dir` from a shipped example: anybench.yaml, adapters/,
 * workloads/<id>/{instruction.md,input/,setup.sh}, gates/, proof/{oracle,do_less,regression}/.
 * File modes (the executable bit on every script) are kept. Refuses a non-empty `dir` unless
 * `force`. Throws KitScaffoldError.
 */
export async function scaffoldKit(
  dir: string,
  opts: ScaffoldKitOptions = {},
): Promise<ScaffoldKitResult> {
  const template = opts.template ?? DEFAULT_KIT_TEMPLATE;
  if (!isKitTemplate(template)) {
    throw new KitScaffoldError(
      `unknown template '${String(template)}' (one of ${KIT_TEMPLATES.join(", ")})`,
    );
  }
  const src = path.join(opts.examplesDir ?? defaultExamplesDir(), template);
  if (!existsSync(path.join(src, KIT_LAYOUT.manifest))) {
    throw new KitScaffoldError(`template '${template}' not found at ${src}`);
  }
  const abs = path.resolve(dir);
  if (existsSync(abs)) {
    const st = await lstat(abs);
    if (!st.isDirectory()) throw new KitScaffoldError(`${abs} exists and is not a directory`);
    const entries = (await readdir(abs)).filter((n) => !HASH_IGNORED_NAMES.has(n));
    if (entries.length > 0 && opts.force !== true) {
      throw new KitScaffoldError(
        `${abs} is not empty (${entries.length} entr${entries.length === 1 ? "y" : "ies"}); pass force to write into it`,
      );
    }
  }
  await mkdir(abs, { recursive: true });
  const files = await listFiles(src);
  await cp(src, abs, {
    recursive: true,
    force: true,
    filter: (from) => !HASH_IGNORED_NAMES.has(path.basename(from)),
  });

  // The example's header comment points at the example and its generator; a scaffold's points at
  // the next commands. Everything from the first non-comment line on is the example's, verbatim.
  const manifest = path.join(abs, KIT_LAYOUT.manifest);
  const lines = (await readFile(manifest, "utf8")).split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.startsWith("#") || lines[i]!.trim() === "")) i++;
  await writeFile(manifest, scaffoldHeader(template) + lines.slice(i).join("\n"));

  return { dir: abs, template, files };
}
