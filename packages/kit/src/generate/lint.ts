// TDM-60 [6.6]: validation of a generated kit before it is handed to the pipeline.
//
//   noLeakIssues(dir, spec)      plan 17.2 rule 5 + the founder's rule 6: nothing answer-bearing
//                                under workloads/ (no expected/answer/reference/golden/oracle files,
//                                no file whose bytes equal a scoring file under reference/, gates/
//                                or proof/oracle/), and no instruction.md that names a hidden test or
//                                quotes a hidden test's expected value, or points at scoring files.
//   validateGeneratedKit(dir)    loadKit's full validation (KitSpec v2 + every referenced file +
//                                the comparability rules) + noLeakIssues, as one list of lines the
//                                kit designer can be re-asked with.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { KitSpec } from "@anybench/core";
import { sha256Hex } from "../hash.js";
import { KIT_LAYOUT } from "../layout.js";
import { validateKitDir, type LoadedKit } from "../validate.js";

async function listFiles(root: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, child)));
    else if (e.isFile()) out.push(child);
  }
  return out.sort();
}

const ANSWER_NAME =
  /(^|[/._-])(expected|answers?|golden|solutions?|oracle|reference|hidden[-_]?tests?)([/._-]|$)/i;
const ANSWER_FILE = /(^|\/)(stdout\.txt|gate\.json)$/i;

/** Test names (`it("…")`, `test('…')`, `def test_x`, `func TestX`) and quoted expected values. */
export function hiddenTestMarkers(source: string): { names: string[]; values: string[] } {
  const names = new Set<string>();
  const values = new Set<string>();
  for (const m of source.matchAll(/\b(?:it|test|describe)\s*\(\s*(["'`])([^"'`\n]{6,160})\1/g))
    names.add(m[2]!);
  for (const m of source.matchAll(/\bdef\s+(test_[A-Za-z0-9_]{3,80})/g)) names.add(m[1]!);
  for (const m of source.matchAll(/\bfunc\s+(Test[A-Za-z0-9_]{3,80})\s*\(/g)) names.add(m[1]!);
  for (const m of source.matchAll(
    /\b(?:assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|match)|expect\([^)]*\)\.(?:toBe|toEqual|toStrictEqual|toContain))\s*\([^,)]*,?\s*(["'`])([^"'`\n]{12,160})\1/g,
  ))
    values.add(m[2]!);
  return { names: [...names], values: [...values] };
}

/** Answer-bearing files under workloads/ and hidden-test details in instructions. */
export async function noLeakIssues(dir: string, spec: KitSpec): Promise<string[]> {
  const issues: string[] = [];
  const workloadFiles = await listFiles(dir, KIT_LAYOUT.workloadsDir);
  const scoringRoots = [KIT_LAYOUT.referenceDir, KIT_LAYOUT.gatesDir, KIT_LAYOUT.proofOracleDir];
  const workloadIds = new Set(spec.workloads.map((w) => w.id));
  // A scoring file belongs to the workload whose id is one of its path segments (gates/<g>/<id>/,
  // reference/<g>/<id>/, proof/oracle/<id>/), else to every workload. A later task's starting
  // repo may legitimately hold an EARLIER task's fix, so files are compared per workload.
  const scoring: { rel: string; sha: string; workload: string | null }[] = [];
  for (const root of scoringRoots) {
    for (const rel of await listFiles(dir, root)) {
      const data = await readFile(path.join(dir, rel));
      if (data.byteLength < 16) continue;
      const workload = rel.split("/").find((seg) => workloadIds.has(seg)) ?? null;
      scoring.push({ rel, sha: sha256Hex(data), workload });
    }
  }

  for (const rel of workloadFiles) {
    const parts = rel.split("/");
    const wid = parts[1] ?? "";
    const inner = parts.slice(2).join("/"); // drop workloads/<id>/
    if (ANSWER_NAME.test(inner) || ANSWER_FILE.test(inner)) {
      issues.push(
        `${rel}: answer-bearing name under workloads/ (answers live in reference/ or gates/ only)`,
      );
      continue;
    }
    const data = await readFile(path.join(dir, rel));
    if (data.byteLength < 16) continue;
    const sha = sha256Hex(data);
    const hit = scoring.find((x) => x.sha === sha && (x.workload === null || x.workload === wid));
    if (hit) issues.push(`${rel}: identical to the scoring file ${hit.rel}`);
  }

  // Hidden-test details in instructions.
  const markers = { names: new Set<string>(), values: new Set<string>() };
  for (const rel of await listFiles(dir, KIT_LAYOUT.gatesDir)) {
    if (!/\.(m?[jt]s|py|go|rs|sh|rb)$/.test(rel)) continue;
    const m = hiddenTestMarkers(await readFile(path.join(dir, rel), "utf8"));
    m.names.forEach((n) => markers.names.add(n));
    m.values.forEach((v) => markers.values.add(v));
  }
  for (const w of spec.workloads) {
    if (!w.instruction) continue;
    let text: string;
    try {
      text = await readFile(path.join(dir, w.instruction), "utf8");
    } catch {
      continue; // the validator reports a missing instruction
    }
    for (const n of markers.names)
      if (text.includes(n)) issues.push(`${w.instruction}: names the hidden test '${n}'`);
    for (const v of markers.values)
      if (text.includes(v)) issues.push(`${w.instruction}: quotes a hidden test's expected value`);
    if (/(^|[\s(`'"])(gates|reference|proof)\//.test(text))
      issues.push(`${w.instruction}: points at scoring-only kit files`);
  }
  return issues;
}

export interface GeneratedKitValidation {
  ok: boolean;
  /** One line per problem (`anybench.yaml:L:C: path: message`, or a no-leak finding). */
  issues: string[];
  warnings: string[];
  kit?: LoadedKit;
}

/** loadKit's validation (incl. comparability) + the no-leak lint. */
export async function validateGeneratedKit(dir: string): Promise<GeneratedKitValidation> {
  const v = await validateKitDir(dir);
  const warnings = v.warnings.map((w) => `${w.code}: ${w.message}`);
  if (!v.ok || !v.kit) return { ok: false, issues: v.lines, warnings };
  const leaks = await noLeakIssues(v.dir, v.kit.spec);
  if (leaks.length > 0) return { ok: false, issues: leaks, warnings };
  return { ok: true, issues: [], warnings, kit: v.kit };
}
