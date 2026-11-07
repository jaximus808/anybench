// validateKitDir: anybench.yaml + every file it references, checked against the folder layout (TDM-33 [4.1]).
//
// 1. anybench.yaml parses (YAML) and validates (KitSpec v2, including the core rule: every
//    measured requirement names a gate, and every measured gate has an oracle).
// 2. Every referenced file exists inside the kit: adapters/<id>/{install,driver}.sh,
//    gates/<id>/check.sh, workloads/<id>/..., reference paths, proof overlays, rubric.md.
// 3. Every workload's bytes hash deterministically (sha256 per file + manifest), and a declared
//    `sha256` matches.
// Errors point at anybench.yaml:LINE:COL of the field that references the file.
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { formatIssuePath, type KitSpec } from "@anybench/core";
import { hashKitPaths, type TreeHash } from "./hash.js";
import { formatKitIssue, type KitIssue, type KitIssueCode } from "./issues.js";
import { KIT_LAYOUT, normalizeKitPath } from "./layout.js";
import { parseKitManifest } from "./manifest.js";
import { type KitYamlSource, positionOf } from "./yaml-source.js";

export interface ResolvedContender {
  id: string;
  /** Kit-relative paths after applying the layout defaults. */
  install: string;
  /** Only set when declared, or when the default `adapters/<id>/healthcheck.sh` exists. */
  healthcheck?: string;
  driver: string;
}

export interface ResolvedGate {
  id: string;
  check: string;
  reference?: string;
}

export interface WorkloadDigest extends TreeHash {
  id: string;
}

export interface LoadedKit {
  /** Absolute kit directory. */
  dir: string;
  manifestPath: string;
  spec: KitSpec;
  contenders: ResolvedContender[];
  gates: ResolvedGate[];
  workloads: WorkloadDigest[];
  warnings: KitIssue[];
}

export interface KitValidation {
  ok: boolean;
  /** Absolute kit directory. */
  dir: string;
  errors: KitIssue[];
  warnings: KitIssue[];
  /** One formatted line per error (`anybench.yaml:LINE:COL: path: message`). */
  lines: string[];
  kit?: LoadedKit;
}

type Kind = "file" | "dir" | "any";
type FieldPath = readonly PropertyKey[];

class KitChecker {
  readonly errors: KitIssue[] = [];
  readonly warnings: KitIssue[] = [];
  private readonly textCache = new Map<string, string>();

  constructor(
    readonly dir: string,
    private readonly realDir: string,
    private readonly source: KitYamlSource,
  ) {}

  add(
    severity: "error" | "warning",
    code: KitIssueCode,
    at: FieldPath | undefined,
    message: string,
    file?: string,
  ) {
    const pos = at ? positionOf(this.source, at) : undefined;
    const issue: KitIssue = {
      severity,
      code,
      file: file ?? this.source.file,
      ...(pos ? { line: pos.line, col: pos.col } : {}),
      ...(at ? { path: formatIssuePath(at) } : {}),
      message,
    };
    (severity === "error" ? this.errors : this.warnings).push(issue);
  }

  /**
   * Check that `rel` exists inside the kit with the right type. `defaultOf` names the field the
   * path was defaulted for (e.g. `driver.script`) so the message says how to point elsewhere.
   */
  async path(
    rel: string,
    at: FieldPath,
    opts: { kind: Kind; required: boolean; executable?: boolean; defaultOf?: string },
  ): Promise<boolean> {
    const abs = path.join(this.dir, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      if (opts.required) {
        const hint = opts.defaultOf
          ? ` (the default for ${opts.defaultOf}; create it or set ${opts.defaultOf} to another path)`
          : "";
        this.add("error", "missing_file", at, `${rel} does not exist${hint}`);
      }
      return false;
    }
    const real = await realpath(abs);
    if (real !== this.realDir && !real.startsWith(this.realDir + path.sep)) {
      this.add("error", "outside_kit", at, `${rel} resolves outside the kit (symlink to ${real})`);
      return false;
    }
    if (opts.kind === "file" && !st.isFile()) {
      this.add("error", "wrong_file_type", at, `${rel} is not a regular file`);
      return false;
    }
    if (opts.kind === "dir" && !st.isDirectory()) {
      this.add("error", "wrong_file_type", at, `${rel} is not a directory`);
      return false;
    }
    if (opts.executable && st.isFile() && (st.mode & 0o111) === 0) {
      this.add("warning", "not_executable", at, `${rel} is not executable (chmod +x ${rel})`);
    }
    return true;
  }

  async text(rel: string): Promise<string> {
    let t = this.textCache.get(rel);
    if (t === undefined) {
      t = await readFile(path.join(this.dir, rel), "utf8");
      this.textCache.set(rel, t);
    }
    return t;
  }

  async subdirs(rel: string): Promise<string[]> {
    try {
      const entries = await readdir(path.join(this.dir, rel), { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  async isDir(rel: string): Promise<boolean> {
    try {
      return (await stat(path.join(this.dir, rel))).isDirectory();
    } catch {
      return false;
    }
  }
}

async function checkContenders(c: KitChecker, spec: KitSpec): Promise<ResolvedContender[]> {
  const out: ResolvedContender[] = [];
  for (const [i, k] of spec.contenders.entries()) {
    const base = ["contenders", i] as const;
    const install = k.install.script ?? KIT_LAYOUT.installScript(k.id);
    await c.path(install, [...base, "install", "script"], {
      kind: "file",
      required: true,
      executable: true,
      ...(k.install.script ? {} : { defaultOf: "install.script" }),
    });

    let healthcheck: string | undefined;
    if (k.install.healthcheck !== undefined) {
      healthcheck = k.install.healthcheck;
      await c.path(healthcheck, [...base, "install", "healthcheck"], {
        kind: "file",
        required: true,
        executable: true,
      });
    } else {
      const def = KIT_LAYOUT.healthcheckScript(k.id);
      if (
        await c.path(def, [...base, "install", "healthcheck"], {
          kind: "file",
          required: false,
          executable: true,
        })
      )
        healthcheck = def;
    }

    const driver = k.driver.script ?? KIT_LAYOUT.driverScript(k.id);
    await c.path(driver, [...base, "driver", "script"], {
      kind: "file",
      required: true,
      executable: true,
      ...(k.driver.script ? {} : { defaultOf: "driver.script" }),
    });

    if ("upload" in k.source) {
      for (const [j, u] of k.source.upload.entries()) {
        await c.path(u, [...base, "source", "upload", j], { kind: "any", required: true });
      }
    }
    out.push({ id: k.id, install, driver, ...(healthcheck ? { healthcheck } : {}) });
  }
  return out;
}

async function checkWorkloads(c: KitChecker, spec: KitSpec): Promise<WorkloadDigest[]> {
  const out: WorkloadDigest[] = [];
  for (const [i, w] of spec.workloads.entries()) {
    const base = ["workloads", i] as const;
    const wdir = KIT_LAYOUT.workloadDir(w.id);
    const parts: string[] = [];
    let missing = false;
    for (const [field, kind] of [
      ["input", "any"],
      ["instruction", "file"],
      ["setup", "file"],
    ] as const) {
      const rel = w[field];
      if (rel === undefined) continue;
      const ok = await c.path(rel, [...base, field], {
        kind,
        required: true,
        executable: field === "setup",
      });
      if (ok) parts.push(rel);
      else missing = true;
    }
    if (await c.isDir(wdir)) parts.push(wdir);
    if (missing) continue;
    if (parts.length === 0) {
      c.add(
        "error",
        "workload_empty",
        base,
        `workload '${w.id}' has no bytes: add ${KIT_LAYOUT.workloadInput(w.id)}/ or ${KIT_LAYOUT.workloadInstruction(w.id)}, or set input`,
      );
      continue;
    }
    const { hash, problems } = await hashKitPaths(c.dir, parts);
    for (const p of problems) {
      if (p.kind === "symlink")
        c.add(
          "error",
          "workload_symlink",
          base,
          `${p.path} is a symlink: workload files must be plain files so their bytes hash the same on every machine`,
        );
      else if (p.kind === "special")
        c.add(
          "error",
          "workload_special_file",
          base,
          `${p.path} is not a regular file or directory`,
        );
    }
    if (problems.length > 0) continue;
    if (hash.files.length === 0) {
      c.add(
        "error",
        "workload_empty",
        base,
        `workload '${w.id}' has no files under ${parts.join(", ")}`,
      );
      continue;
    }
    if (w.sha256 !== undefined && w.sha256 !== hash.sha256) {
      c.add(
        "error",
        "workload_sha256_mismatch",
        [...base, "sha256"],
        `declared sha256 does not match the workload bytes: computed ${hash.sha256} over ${hash.files.length} file(s)`,
      );
      continue;
    }
    out.push({ id: w.id, ...hash });
  }
  return out;
}

async function checkGates(c: KitChecker, spec: KitSpec): Promise<ResolvedGate[]> {
  const out: ResolvedGate[] = [];
  for (const [i, g] of spec.gates.entries()) {
    const base = ["gates", i] as const;
    const check = g.check ?? KIT_LAYOUT.gateCheck(g.id);
    await c.path(check, [...base, "check"], {
      kind: "file",
      required: true,
      executable: true,
      ...(g.check ? {} : { defaultOf: "check" }),
    });
    let reference: string | undefined;
    if (g.reference !== undefined) {
      if (await c.path(g.reference, [...base, "reference"], { kind: "any", required: true }))
        reference = g.reference;
    } else if (await c.isDir(`${KIT_LAYOUT.gateDir(g.id)}/reference`)) {
      reference = `${KIT_LAYOUT.gateDir(g.id)}/reference/`;
    }
    out.push({ id: g.id, check, ...(reference ? { reference } : {}) });
  }
  return out;
}

async function checkRequirements(c: KitChecker, spec: KitSpec): Promise<void> {
  for (const [i, r] of spec.requirements.entries()) {
    if (r.type !== "reviewed") continue;
    const at = ["requirements", i, "rubric"] as const;
    const exists = await c.path(r.rubric, at, {
      kind: "file",
      required: true,
      ...(r.rubric === KIT_LAYOUT.rubric ? { defaultOf: "rubric" } : {}),
    });
    if (exists && r.criterion !== undefined) {
      const text = await c.text(r.rubric);
      if (!text.toLowerCase().includes(r.criterion.toLowerCase())) {
        c.add(
          "error",
          "rubric_criterion_missing",
          ["requirements", i, "criterion"],
          `criterion '${r.criterion}' does not appear in ${r.rubric}`,
        );
      }
    }
  }
}

async function checkProof(c: KitChecker, spec: KitSpec): Promise<void> {
  const overlays: {
    at: PropertyKey[];
    dir: string;
    driver_patch?: string | undefined;
    home: string;
  }[] = [];
  const { oracle, do_less, regression } = spec.proof;
  if (oracle)
    overlays.push({ at: ["proof", "oracle"], ...oracle, home: KIT_LAYOUT.proofOracleDir });
  do_less.forEach((o, i) =>
    overlays.push({ at: ["proof", "do_less", i], ...o, home: KIT_LAYOUT.proofDoLessDir }),
  );
  if (regression)
    overlays.push({
      at: ["proof", "regression"],
      ...regression,
      home: KIT_LAYOUT.proofRegressionDir,
    });

  for (const o of overlays) {
    const dir = normalizeKitPath(o.dir);
    if (await c.path(o.dir, [...o.at, "dir"], { kind: "dir", required: true })) {
      if (dir !== o.home && !dir.startsWith(`${o.home}/`)) {
        c.add(
          "warning",
          "proof_dir_misplaced",
          [...o.at, "dir"],
          `${o.dir} is outside ${o.home}/, where the layout keeps this overlay`,
        );
      }
    }
    if (o.driver_patch !== undefined) {
      await c.path(o.driver_patch, [...o.at, "driver_patch"], { kind: "file", required: true });
    }
  }
}

async function checkEnv(c: KitChecker, spec: KitSpec): Promise<void> {
  for (const [j, f] of (spec.env?.fixtures ?? []).entries()) {
    await c.path(f.src, ["env", "fixtures", j, "src"], { kind: "any", required: true });
  }
}

/** Warn about adapters/<x>, gates/<x>, workloads/<x> folders no entry in anybench.yaml owns. */
async function checkUnused(c: KitChecker, spec: KitSpec): Promise<void> {
  const owners: [string, string, Set<string>][] = [
    [KIT_LAYOUT.adaptersDir, "contender", new Set(spec.contenders.map((x) => x.id))],
    [KIT_LAYOUT.gatesDir, "gate", new Set(spec.gates.map((x) => x.id))],
    [KIT_LAYOUT.workloadsDir, "workload", new Set(spec.workloads.map((x) => x.id))],
  ];
  for (const [dir, what, ids] of owners) {
    for (const name of await c.subdirs(dir)) {
      if (!ids.has(name))
        c.add("warning", "unused_dir", undefined, `no ${what} has id '${name}'`, `${dir}/${name}/`);
    }
  }
}

const byPosition = (a: KitIssue, b: KitIssue) =>
  (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
  (a.col ?? 0) - (b.col ?? 0);

function result(
  dir: string,
  errors: KitIssue[],
  warnings: KitIssue[],
  kit?: LoadedKit,
): KitValidation {
  const sorted = [...errors].sort(byPosition);
  return {
    ok: sorted.length === 0,
    dir,
    errors: sorted,
    warnings,
    lines: sorted.map(formatKitIssue),
    ...(kit && sorted.length === 0 ? { kit } : {}),
  };
}

/** Validate a kit directory. Never throws for a bad kit: every problem is an issue. */
export async function validateKitDir(dir: string = "."): Promise<KitValidation> {
  const abs = path.resolve(dir);
  const file = KIT_LAYOUT.manifest;
  try {
    if (!(await stat(abs)).isDirectory()) throw new Error("not a directory");
  } catch {
    return result(
      abs,
      [
        {
          severity: "error",
          code: "kit_dir_missing",
          file: abs,
          message: "kit directory does not exist",
        },
      ],
      [],
    );
  }
  const manifestPath = path.join(abs, file);
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return result(
      abs,
      [{ severity: "error", code: "manifest_missing", file, message: `not found in ${abs}` }],
      [],
    );
  }

  const parsed = parseKitManifest(text, file);
  if (!parsed.spec) return result(abs, parsed.errors, parsed.warnings);
  const spec = parsed.spec;

  const c = new KitChecker(abs, await realpath(abs), parsed.source);
  c.warnings.push(...parsed.warnings);
  const contenders = await checkContenders(c, spec);
  const workloads = await checkWorkloads(c, spec);
  const gates = await checkGates(c, spec);
  await checkRequirements(c, spec);
  await checkProof(c, spec);
  await checkEnv(c, spec);
  await checkUnused(c, spec);

  return result(abs, c.errors, c.warnings, {
    dir: abs,
    manifestPath,
    spec,
    contenders,
    gates,
    workloads,
    warnings: c.warnings,
  });
}
