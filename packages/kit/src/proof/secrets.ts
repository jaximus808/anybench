// TDM-44 [4.12] proof check `no_secret_in_kit`: no credential anywhere in the kit (plan.md P2).
//
// Every file under the kit directory is scanned (anybench.yaml, adapters, workloads, gates,
// reference, proof, anything else), with two layers, the same as core's redactor:
//   1. exact values: the worker's configured secret values, passed in by the server. A value
//      shorter than MIN_EXACT_SECRET_LENGTH is ignored (it would match ordinary text);
//   2. known key shapes: core's SECRET_PATTERNS (sk-ant-, sk-proj-, sk-…, ghp_/gho_/…,
//      github_pat_, sk_live_/sk_test_, rk_, whsec_, ab_live_) plus shapes only a kit scan needs
//      (AWS access key ids, PEM private keys, Slack tokens, Google API keys).
//
// A finding names the file, the line and the pattern, NEVER the matched text: the result goes on
// the kit row and back to the kit designer.
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SECRET_PATTERNS } from "@anybench/core";
import { HASH_IGNORED_NAMES } from "../hash.js";

/** Secret shapes a kit may not contain beyond core's redact patterns. */
export const KIT_EXTRA_SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "AWS_ACCESS_KEY_ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "PRIVATE_KEY", re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/g },
  { name: "SLACK_TOKEN", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "GOOGLE_API_KEY", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

/** Every pattern the kit scan uses: core's first, then the kit-only ones. */
export const KIT_SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  ...SECRET_PATTERNS,
  ...KIT_EXTRA_SECRET_PATTERNS,
];

/** Exact secret values shorter than this are not matched (too likely to be ordinary text). */
export const MIN_EXACT_SECRET_LENGTH = 8;
/** Files larger than this are scanned in their first MAX_SCAN_BYTES only (and say so). */
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** Directories never scanned: VCS metadata and dependency caches are not kit content. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

export interface SecretFinding {
  /** Kit-relative path, `/`-separated. */
  file: string;
  /** 1-based line of the first match in that file. */
  line: number;
  /** Pattern name (`ANTHROPIC_API_KEY`, …) or `EXACT_VALUE` for a configured secret's value. */
  kind: string;
}

export interface SecretScan {
  findings: SecretFinding[];
  filesScanned: number;
  /** Files larger than MAX_SCAN_BYTES (only their head was scanned). */
  truncated: string[];
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The literal forms a value takes in a file: raw and JSON-escaped (as core's redactor). */
function literalForms(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped === value ? [value] : [value, escaped];
}

/** Scan one text for secrets. Exported for tests and for scanning a draft before it is written. */
export function findSecretsInText(
  text: string,
  exactValues: readonly string[] = [],
): { kind: string; index: number }[] {
  const hits: { kind: string; index: number }[] = [];
  for (const value of exactValues) {
    if (value.length < MIN_EXACT_SECRET_LENGTH) continue;
    for (const form of literalForms(value)) {
      const i = text.indexOf(form);
      if (i >= 0) {
        hits.push({ kind: "EXACT_VALUE", index: i });
        break;
      }
    }
  }
  // Most specific first: a match overlapping an earlier pattern's match is the same secret (an
  // sk-ant- key is not also reported as a generic sk- key), as in core's redactor.
  const spans: [number, number][] = [];
  for (const { name, re } of KIT_SECRET_PATTERNS) {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(r)) {
      const end = m.index + m[0].length;
      if (spans.some(([a, b]) => m.index < b && end > a)) continue;
      spans.push([m.index, end]);
      if (!hits.some((h) => h.kind === name)) hits.push({ kind: name, index: m.index });
    }
  }
  return hits;
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    if (HASH_IGNORED_NAMES.has(e.name)) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIPPED_DIRS.has(e.name)) continue;
      await walk(root, child, out);
    } else if (e.isFile() || e.isSymbolicLink()) {
      out.push(child);
    }
  }
}

/**
 * Scan every file of the kit at `kitDir`. Symlinks are scanned only when they point at a regular
 * file (the loader refuses links out of the kit anyway). Never returns or logs a matched value.
 */
export async function scanKitForSecrets(
  kitDir: string,
  opts: { exactValues?: readonly string[] } = {},
): Promise<SecretScan> {
  const files: string[] = [];
  await walk(kitDir, "", files);
  files.sort();
  const findings: SecretFinding[] = [];
  const truncated: string[] = [];
  let filesScanned = 0;
  for (const rel of files) {
    const abs = path.join(kitDir, rel);
    const st = await lstat(abs).catch(() => undefined);
    if (!st) continue;
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      continue; // a dangling link: nothing to read
    }
    if (buf.length > MAX_SCAN_BYTES) {
      truncated.push(rel);
      buf = buf.subarray(0, MAX_SCAN_BYTES);
    }
    filesScanned++;
    // latin1 keeps every byte (binary files too) so a key embedded anywhere still matches.
    const text = buf.toString("latin1");
    const seen = new Set<string>();
    for (const hit of findSecretsInText(text, opts.exactValues ?? [])) {
      if (seen.has(hit.kind)) continue;
      seen.add(hit.kind);
      findings.push({ file: rel, line: lineOf(text, hit.index), kind: hit.kind });
    }
  }
  return { findings, filesScanned, truncated };
}
