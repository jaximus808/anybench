#!/usr/bin/env node
// kits/harness-league shares its arena with kits/tandem-long-horizon (E18): the same workloads,
// hidden-tests gate, proof, rubric and scripts, and the same adapters for the setups both kits run
// (A claude-code-solo, D tandem), plus setup B's subagents from kits/tandem-vs-claude-code.
// KitSpec has no cross-kit reference (validateKitDir refuses any path that resolves outside the
// kit), so this script copies them byte for byte; --check fails on any difference, which keeps
// E18's PROOF.md sign-off valid for this kit and lets D reuse E18 results (TDM-227 [21.1]).
//
//   node kits/harness-league/scripts/sync-shared.mjs           # copy (and delete stale copies)
//   node kits/harness-league/scripts/sync-shared.mjs --check   # exit 1 if anything differs
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const league = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kits = path.dirname(league);
const LONG = path.join(kits, "tandem-long-horizon");
const TEMPLATE = path.join(kits, "tandem-vs-claude-code");

/** [source kit, kit-relative path]: a directory is mirrored (extra files in the copy are stale). */
export const SHARED = [
  [LONG, "workloads"],
  [LONG, "gates"],
  [LONG, "proof"],
  [LONG, "rubric.md"],
  [LONG, "PROOF.md"],
  [LONG, "scripts/ab-run-local.sh"],
  [LONG, "scripts/gen-hidden-tests-manifest.mjs"],
  [LONG, "scripts/gen-seed-v1.mjs"],
  [LONG, "scripts/proof-in-container.sh"],
  [LONG, "scripts/setup-workspace.sh"],
  [LONG, "scripts/verify-proof.sh"],
  [LONG, "adapters/claude-code"],
  [LONG, "adapters/claude-code-solo"],
  [LONG, "adapters/tandem"],
  [TEMPLATE, "adapters/claude-code-subagents"],
];

const SKIP = new Set([".DS_Store", "node_modules"]);

function files(root, rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...files(root, r));
    else if (e.isFile()) out.push(r);
    else throw new Error(`${path.join(root, r)} is not a regular file`);
  }
  return out.sort();
}

const mode = (p) => statSync(p).mode & 0o777;

/** Every difference between the shared sources and their copies in the league kit. */
export function diffShared() {
  const problems = [];
  for (const [src, rel] of SHARED) {
    const want = files(src, rel);
    if (want.length === 0) problems.push({ kind: "source-missing", path: rel, src });
    for (const f of want) {
      const a = path.join(src, f);
      const b = path.join(league, f);
      if (!existsSync(b)) problems.push({ kind: "missing", path: f, src });
      else if (!readFileSync(a).equals(readFileSync(b))) problems.push({ kind: "differs", path: f, src });
      else if ((mode(a) & 0o111) !== (mode(b) & 0o111)) problems.push({ kind: "mode", path: f, src });
    }
    const have = new Set(want);
    for (const f of files(league, rel)) if (!have.has(f)) problems.push({ kind: "stale", path: f, src });
  }
  return problems;
}

function sync() {
  for (const p of diffShared()) {
    const dst = path.join(league, p.path);
    if (p.kind === "stale") rmSync(dst);
    if (p.kind === "missing" || p.kind === "differs" || p.kind === "mode") {
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(path.join(p.src, p.path), dst);
      chmodSync(dst, mode(path.join(p.src, p.path)));
    }
    if (p.kind !== "source-missing") console.log(`${p.kind === "stale" ? "removed" : "copied"} ${p.path}`);
    else throw new Error(`shared source ${path.join(p.src, p.path)} does not exist`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const problems = diffShared();
    for (const p of problems)
      console.error(`${p.kind}: ${p.path} (from ${path.relative(kits, p.src)})`);
    if (problems.length > 0) {
      console.error(`${problems.length} shared file(s) out of sync: run node kits/harness-league/scripts/sync-shared.mjs`);
      process.exit(1);
    }
    console.log(`harness-league: ${SHARED.length} shared paths byte-identical to their sources`);
  } else sync();
}
