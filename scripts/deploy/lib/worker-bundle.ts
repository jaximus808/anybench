// The worker release (worker-naive): apps/server/dist/worker.js and the on-host rotator bundled
// with esbuild (workspace code inlined, npm packages installed on the host from package.json),
// plus every file the bundled code reads from disk. The layout is fixed by the four
// `import.meta.url` sites in the bundle, which all resolve against <release>/dist/:
//
//   <release>/dist/worker.js, dist/rotate.js   the bundles
//   <release>/recipes/                         packages/envs BASE_RECIPES_DIR  (dist/../recipes)
//   <release>/<role>/config.json …             packages/agents DEFAULT_ROLES_DIR (dist/../)
//   <release>/kits/                            curated kits (ANYBENCH_KITS_DIR, set by run-worker.sh)
//   <release>/bin/runner-linux-{x64,arm64}     env-build runner binaries (ANYBENCH_RUNNER_BIN_DIR)
//   <release>/package.json                     the npm dependencies, exact versions
//
// `checkResourceSites` fails the build when the bundle grows an import.meta.url this layout does
// not know about, instead of shipping a worker that cannot find its files.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { build } from "esbuild";
import { CREATE_REQUIRE_BANNER, externalNpmPlugin, pickVersions } from "./bundle.js";

export interface ReleaseEntry {
  /** Path inside the release, `/`-separated. */
  path: string;
  mode: number;
  /** In-memory content, or … */
  bytes?: Buffer;
  /** … a file on disk (the runner binaries are ~90 MB each). */
  file?: string;
}

export interface WorkerRelease {
  entries: ReleaseEntry[];
  dependencies: Record<string, string>;
  warnings: string[];
  /** 32 hex of the content hash: the release id (dir name on the host, computer tag, R2 key). */
  id: string;
  totalBytes: number;
}

/** The import.meta.url uses the release layout serves. Anything else fails the build. */
export const KNOWN_RESOURCE_SITES = [
  {
    what: "packages/envs recipes",
    re: /dirname\(fileURLToPath\d*\(import\.meta\.url\)\), "\.\.", "recipes"\)/,
  },
  {
    what: "packages/agents roles",
    re: /fileURLToPath\d*\(new URL\("\.\.\/", import\.meta\.url\)\)/,
  },
  {
    what: "runner bin dir",
    re: /path\d*\.dirname\(fileURLToPath\d*\(import\.meta\.url\)\),\s*"\.\.\/\.\.\/\.\.\/\.\.\/packages\/runner\/dist\/bin"/,
  },
  { what: "kits dir", re: /let dir = path\d*\.dirname\(fileURLToPath\d*\(import\.meta\.url\)\);/ },
  { what: "createRequire banner", re: /__anybenchCreateRequire\(import\.meta\.url\)/ },
] as const;

/** Throws if `code` uses import.meta.url anywhere the release layout does not account for. */
export function checkResourceSites(code: string): string[] {
  const total = code.split("import.meta.url").length - 1;
  let known = 0;
  const found: string[] = [];
  for (const site of KNOWN_RESOURCE_SITES) {
    const n = code.split(new RegExp(site.re.source, "g")).length - 1;
    if (n > 0) found.push(site.what);
    known += n;
  }
  if (known !== total) {
    throw new Error(
      `the bundle reads ${total - known} file path(s) from import.meta.url that the worker release ` +
        "layout does not ship; extend scripts/deploy/lib/worker-bundle.ts",
    );
  }
  return found;
}

function walk(dir: string, skip = new Set(["node_modules", ".DS_Store", ".git"])): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, skip));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function tree(srcDir: string, destPrefix: string): ReleaseEntry[] {
  return walk(srcDir).map((f) => ({
    path: `${destPrefix}/${relative(srcDir, f).split("\\").join("/")}`,
    mode: statSync(f).mode & 0o111 ? 0o755 : 0o644,
    file: f,
  }));
}

/** packages/agents/<role>/ for every directory holding a config.json. */
export function agentRoleDirs(agentsPkg: string): string[] {
  return readdirSync(agentsPkg)
    .filter((n) => !["dist", "src", "test", "node_modules"].includes(n))
    .filter((n) => existsSync(join(agentsPkg, n, "config.json")))
    .sort();
}

async function sha256Of(e: ReleaseEntry): Promise<string> {
  const h = createHash("sha256");
  if (e.bytes) return h.update(e.bytes).digest("hex");
  await new Promise<void>((res, rej) =>
    createReadStream(e.file!)
      .on("data", (c) => h.update(c))
      .on("end", res)
      .on("error", rej),
  );
  return h.digest("hex");
}

/** sha256 over the sorted (path, mode, content sha) list: equal content, equal id. */
export async function releaseId(entries: readonly ReleaseEntry[]): Promise<string> {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${e.path}\0${e.mode.toString(8)}\0${await sha256Of(e)}\n`);
  }
  return h.digest("hex").slice(0, 32);
}

const RESERVED = new Set(["dist", "recipes", "kits", "bin", "node_modules", "package.json"]);

export async function bundleWorkerRelease(opts: {
  repoRoot: string;
  /** Built worker entry (apps/server/dist/worker.js). */
  workerEntry: string;
  /** The on-host rotator (scripts/deploy/worker-rotate.ts). */
  rotateEntry: string;
  nodeMajor?: number;
}): Promise<WorkerRelease> {
  const nodeMajor = opts.nodeMajor ?? 22;
  const seen = new Map<string, Set<string>>();
  const result = await build({
    entryPoints: { worker: opts.workerEntry, rotate: opts.rotateEntry },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: `node${nodeMajor}`,
    outdir: "dist",
    plugins: [externalNpmPlugin("@anybench/", seen)],
    banner: { js: CREATE_REQUIRE_BANNER },
    legalComments: "none",
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    throw new Error(`bundle failed: ${result.errors.map((e) => e.text).join("; ")}`);
  }
  const entries: ReleaseEntry[] = [];
  for (const out of result.outputFiles) {
    const name = out.path.split(/[\\/]/).at(-1)!;
    const code = Buffer.from(out.contents);
    checkResourceSites(code.toString("utf8"));
    entries.push({ path: `dist/${name}`, mode: 0o644, bytes: code });
  }
  if (
    !entries.some((e) => e.path === "dist/worker.js") ||
    !entries.some((e) => e.path === "dist/rotate.js")
  ) {
    throw new Error("bundle produced no dist/worker.js or dist/rotate.js");
  }

  const r = (p: string) => join(opts.repoRoot, p);
  entries.push(...tree(r("kits"), "kits"));
  entries.push(...tree(r("packages/envs/recipes"), "recipes"));
  const roles = agentRoleDirs(r("packages/agents"));
  for (const role of roles) {
    if (RESERVED.has(role)) throw new Error(`agent role ${role} collides with the release layout`);
    entries.push(...tree(r(`packages/agents/${role}`), role));
  }
  const bins = ["x64", "arm64"]
    .map((a) => r(`packages/runner/dist/bin/runner-linux-${a}`))
    .filter((f) => existsSync(f));
  if (bins.length === 0) {
    throw new Error(
      "no runner binaries in packages/runner/dist/bin (pnpm --filter @anybench/runner build:bin)",
    );
  }
  for (const f of bins) entries.push({ path: `bin/${f.split("/").at(-1)}`, mode: 0o755, file: f });

  const { dependencies, warnings } = pickVersions(seen);
  const packageJson = {
    name: "anybench-worker",
    private: true,
    type: "module",
    description: "Anybench graphile worker release (scripts/deploy/worker.ts)",
    engines: { node: `>=${nodeMajor}` },
    dependencies,
  };
  entries.push({
    path: "package.json",
    mode: 0o644,
    bytes: Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`),
  });

  let totalBytes = 0;
  for (const e of entries) totalBytes += e.bytes ? e.bytes.length : statSync(e.file!).size;
  return { entries, dependencies, warnings, id: await releaseId(entries), totalBytes };
}

/** Lay the release out in a temp dir and tar.gz it. Returns the tarball's sha256 and size. */
export async function writeReleaseTarball(
  release: WorkerRelease,
  outFile: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const staging = await mkdtemp(join(tmpdir(), "anybench-worker-release-"));
  try {
    for (const e of release.entries) {
      const dest = join(staging, ...e.path.split("/"));
      await mkdir(dirname(dest), { recursive: true });
      if (e.bytes) await writeFile(dest, e.bytes);
      else await copyFile(e.file!, dest);
      await chmod(dest, e.mode);
    }
    const args = ["-czf", outFile, "-C", staging];
    // bsdtar on macOS would add AppleDouble/xattr members that GNU tar on the host warns about.
    if (process.platform === "darwin") args.unshift("--no-mac-metadata", "--no-xattrs");
    const t = spawnSync("tar", [...args, "."], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (t.status !== 0) throw new Error(`tar failed: ${t.stderr.toString().slice(0, 500)}`);
    const bytes = readFileSync(outFile);
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: (await stat(outFile)).size,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
