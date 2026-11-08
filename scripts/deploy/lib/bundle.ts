// Bundle the API for a Vercel-style host (TDM-154). The host runs `npm install` on the package.json
// we ship, so npm packages stay external and are listed there at the exact version this checkout
// resolves. Workspace packages (`@anybench/*`) are not on npm and are bundled in from their dist/.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build, type Plugin } from "esbuild";
import { z } from "zod";

/** `@scope/name/sub/path` → `@scope/name`; `name/sub` → `name`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

const PkgJsonSchema = z.object({ name: z.string(), version: z.string() });

/** The version of `pkg` that Node would load from `fromDir` (walks up node_modules dirs). */
export function resolvedVersion(pkg: string, fromDir: string): string {
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", pkg, "package.json");
    if (existsSync(candidate)) {
      return PkgJsonSchema.parse(JSON.parse(readFileSync(candidate, "utf8"))).version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find ${pkg} from ${fromDir}`);
    dir = parent;
  }
}

/**
 * Merge `{pkg: [versions]}` into one version each. Two different versions of one package would
 * need two copies, which a flat package.json cannot express: refuse on a major mismatch, take the
 * highest otherwise.
 */
export function pickVersions(seen: Map<string, Set<string>>): {
  dependencies: Record<string, string>;
  warnings: string[];
} {
  const dependencies: Record<string, string> = {};
  const warnings: string[] = [];
  const major = (v: string) => v.split(".")[0];
  const cmp = (a: string, b: string) => {
    const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
    const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  for (const pkg of [...seen.keys()].sort()) {
    const versions = [...seen.get(pkg)!].sort(cmp);
    if (new Set(versions.map(major)).size > 1) {
      throw new Error(
        `${pkg}: workspace packages need incompatible versions ${versions.join(", ")}`,
      );
    }
    if (versions.length > 1)
      warnings.push(`${pkg}: using ${versions.at(-1)} (also ${versions.slice(0, -1).join(", ")})`);
    dependencies[pkg] = versions.at(-1)!;
  }
  return { dependencies, warnings };
}

export interface ApiBundle {
  /** Published path → bytes: api/app.js, package.json, vercel.json. */
  files: Record<string, Buffer>;
  /** The npm packages the host installs. */
  dependencies: Record<string, string>;
  warnings: string[];
  /** sha256 over the sorted file map; the deploy's `content_hash`. */
  contentHash: string;
}

export interface BundleOptions {
  /** The built entry (apps/server/dist/entry-naive.js). */
  entry: string;
  /** vercel.json contents. */
  vercelJson: Record<string, unknown>;
  /** Workspace scope bundled in rather than installed. */
  bundledScope?: string;
  nodeMajor?: number;
}

export function contentHashOf(files: Record<string, Buffer>): string {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    h.update(path).update("\0").update(files[path]!).update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

export async function bundleApi(options: BundleOptions): Promise<ApiBundle> {
  const scope = options.bundledScope ?? "@anybench/";
  const nodeMajor = options.nodeMajor ?? 22;
  const seen = new Map<string, Set<string>>();

  const externalNpm: Plugin = {
    name: "external-npm",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.path.startsWith("node:")) return { path: args.path, external: true };
        if (args.path.startsWith(scope)) return undefined; // bundled from the workspace dist/
        const pkg = packageName(args.path);
        const version = resolvedVersion(pkg, args.resolveDir);
        if (!seen.has(pkg)) seen.set(pkg, new Set());
        seen.get(pkg)!.add(version);
        return { path: args.path, external: true };
      });
    },
  };

  const result = await build({
    entryPoints: [options.entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: `node${nodeMajor}`,
    outfile: "api/app.js",
    plugins: [externalNpm],
    // A bundled CommonJS `require` of a builtin needs a real require in an ESM file.
    banner: {
      js: 'import { createRequire as __anybenchCreateRequire } from "node:module";\nconst require = __anybenchCreateRequire(import.meta.url);',
    },
    legalComments: "none",
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    throw new Error(`bundle failed: ${result.errors.map((e) => e.text).join("; ")}`);
  }
  const out = result.outputFiles.find((f) => f.path.endsWith("app.js"));
  if (!out) throw new Error("bundle produced no api/app.js");

  const { dependencies, warnings } = pickVersions(seen);
  const packageJson = {
    name: "anybench-api",
    private: true,
    type: "module",
    engines: { node: `${nodeMajor}.x` },
    dependencies,
  };
  const files: Record<string, Buffer> = {
    "api/app.js": Buffer.from(out.contents),
    "package.json": Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`),
    "vercel.json": Buffer.from(`${JSON.stringify(options.vercelJson, null, 2)}\n`),
  };
  return { files, dependencies, warnings, contentHash: contentHashOf(files) };
}
