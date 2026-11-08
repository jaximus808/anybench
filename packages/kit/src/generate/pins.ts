// TDM-60 [6.6]: pins resolved IN CODE for a generated cli kit. The model only names a repo (and
// maybe a tag); everything a computer will download is pinned here:
//
//   resolveGithubReleasePin  GitHub release (the tag, or the latest release) → per-arch asset
//                            (x86_64: musl preferred, then gnu; aarch64: gnu or musl) → sha256:
//                            the published `<asset>.sha256` when the release ships one (checked
//                            against GitHub's own asset digest when both exist), else GitHub's
//                            asset digest, else download + hash.
//   resolveGnuPin            a GNU baseline from the base image's apt, pinned by version (the
//                            healthcheck refuses any other) with the matching GNU source tarball
//                            URL + sha256 (download + hash) as its L0 source.
//
// Network goes through an injected `fetch` (tests use fixtures). Hashes are cached on disk by
// URL, so a repair or a rerun does not download the same tarball again.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { GNU_BASELINES, type GnuPackage } from "./cli-draft.js";

export type PinFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

export interface PinDeps {
  fetch?: PinFetch;
  /** GitHub token for the API (rate limit); never logged. */
  githubToken?: string;
  /** sha256 cache by URL. Default ~/.anybench/pins. Null: no cache. */
  cacheDir?: string | null;
  /** Largest file downloaded for hashing. Default 256 MiB. */
  maxDownloadBytes?: number;
}

export class PinError extends Error {
  override readonly name = "PinError";
  /** Our side or the network (429, 5xx, connection): retry later; not the draft's fault. */
  readonly transient: boolean;
  constructor(message: string, opts: { transient?: boolean } = {}) {
    super(message);
    this.transient = opts.transient ?? false;
  }
}

export type Arch = "x86_64" | "aarch64";
export const PIN_ARCHES: readonly Arch[] = ["x86_64", "aarch64"];

export interface ReleaseAssetPin {
  arch: Arch;
  name: string;
  url: string;
  sha256: string;
  sha256_from: "published" | "digest" | "download";
}

export interface GithubReleasePin {
  kind: "github_release";
  repo: string;
  tag: string;
  /** `14.1.1` from `14.1.1`, `v10.2.0`, `ripgrep-14.1.1`. */
  version: string;
  assets: Record<Arch, ReleaseAssetPin>;
}

export interface GnuPin {
  kind: "gnu";
  package: GnuPackage;
  apt_package: string;
  version: string;
  url: string;
  sha256: string;
}

export type CliPin = GithubReleasePin | GnuPin;

const GithubAssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string().url(),
  size: z.number().optional(),
  digest: z.string().nullable().optional(),
});
type GithubAsset = z.infer<typeof GithubAssetSchema>;
const GithubReleaseSchema = z.object({
  tag_name: z.string().min(1),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(GithubAssetSchema),
});

const SHA256 = /\b([a-f0-9]{64})\b/i;
const VERSION = /(\d+\.\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?)/;

/** `v10.2.0` → `10.2.0`, `ripgrep-14.1.1` → `14.1.1`. Throws when the tag carries no x.y.z. */
export function versionOfTag(tag: string): string {
  const m = VERSION.exec(tag);
  if (!m) throw new PinError(`release tag '${tag}' has no x.y.z version, so it cannot be pinned`);
  return m[1]!;
}

const ARCHIVE = /\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tar\.zst|zip)$/i;
const SIDE_FILE = /\.(sha256|sha512|sha256sum|asc|sig|pem|sbom|json|txt|deb|rpm|apk|msi|dmg|pkg)$/i;
const ARCH_RE: Record<Arch, RegExp> = {
  x86_64: /(x86_64|amd64|x64)(?![0-9])/i,
  aarch64: /(aarch64|arm64)/i,
};

/** The release asset a Linux computer of `arch` installs, or null. Pure. */
export function pickReleaseAsset(assets: readonly { name: string }[], arch: Arch): string | null {
  const candidates = assets
    .map((a) => a.name)
    .filter((n) => /linux/i.test(n) && ARCH_RE[arch].test(n) && !SIDE_FILE.test(n))
    .filter((n) => !/android/i.test(n));
  if (candidates.length === 0) return null;
  const score = (n: string): number => {
    let s = 0;
    if (/\.(tar\.gz|tgz)$/i.test(n)) s += 30;
    else if (/\.(tar\.xz|txz)$/i.test(n)) s += 25;
    else if (ARCHIVE.test(n) && !/\.zip$/i.test(n)) s += 15;
    else if (/\.zip$/i.test(n)) s += 5;
    else s += 20; // a bare binary
    if (/musl/i.test(n)) s += arch === "x86_64" ? 10 : 6;
    else if (/gnu/i.test(n)) s += arch === "x86_64" ? 6 : 8;
    if (/debug|symbols|dbg/i.test(n)) s -= 50;
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0]!;
}

function f(deps: PinDeps): PinFetch {
  const raw: PinFetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return async (url, init) => {
    let res: Response;
    try {
      res = await raw(url, init);
    } catch (err) {
      throw new PinError(`GET ${url}: ${err instanceof Error ? err.message : String(err)}`, {
        transient: true,
      });
    }
    if (
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 403 && /api\.github\.com/.test(url))
    )
      throw new PinError(`GET ${url}: HTTP ${res.status}`, { transient: true });
    return res;
  };
}

async function getJson(url: string, deps: PinDeps): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "anybench-kit-designer",
  };
  if (deps.githubToken) headers.authorization = `Bearer ${deps.githubToken}`;
  const res = await f(deps)(url, { headers });
  if (res.status === 404) throw new PinError(`not found: ${url}`);
  if (!res.ok) throw new PinError(`GET ${url}: HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function getText(url: string, deps: PinDeps): Promise<string> {
  const res = await f(deps)(url, { headers: { "user-agent": "anybench-kit-designer" } });
  if (!res.ok) throw new PinError(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

function cacheFile(deps: PinDeps): string | null {
  if (deps.cacheDir === null) return null;
  return path.join(deps.cacheDir ?? path.join(homedir(), ".anybench", "pins"), "sha256.json");
}

async function readCache(deps: PinDeps): Promise<Record<string, string>> {
  const file = cacheFile(deps);
  if (!file) return {};
  try {
    const parsed = z
      .record(z.string(), z.string())
      .safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

async function writeCache(deps: PinDeps, url: string, sha: string): Promise<void> {
  const file = cacheFile(deps);
  if (!file) return;
  const cache = await readCache(deps);
  cache[url] = sha;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache, null, 2));
}

/** sha256 of the bytes at `url` (download + hash), cached by URL. */
export async function sha256OfUrl(url: string, deps: PinDeps = {}): Promise<string> {
  const cached = (await readCache(deps))[url];
  if (cached && /^[a-f0-9]{64}$/.test(cached)) return cached;
  const res = await f(deps)(url, { headers: { "user-agent": "anybench-kit-designer" } });
  if (!res.ok || !res.body) throw new PinError(`GET ${url}: HTTP ${res.status}`);
  const max = deps.maxDownloadBytes ?? 256 * 1024 * 1024;
  const hash = createHash("sha256");
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new PinError(`${url} is larger than ${max} bytes`);
    }
    hash.update(value);
  }
  const sha = hash.digest("hex");
  await writeCache(deps, url, sha);
  return sha;
}

async function assetSha256(
  asset: GithubAsset,
  all: readonly GithubAsset[],
  deps: PinDeps,
): Promise<Pick<ReleaseAssetPin, "sha256" | "sha256_from">> {
  const digest = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7).toLowerCase() : null;
  const side = all.find((a) =>
    [`${asset.name}.sha256`, `${asset.name}.sha256sum`].includes(a.name),
  );
  if (side) {
    const m = SHA256.exec(await getText(side.browser_download_url, deps));
    if (!m) throw new PinError(`${side.name} holds no sha256`);
    const published = m[1]!.toLowerCase();
    if (digest && digest !== published) {
      throw new PinError(
        `${asset.name}: the published ${side.name} (${published}) disagrees with GitHub's digest (${digest})`,
      );
    }
    return { sha256: published, sha256_from: "published" };
  }
  if (digest && /^[a-f0-9]{64}$/.test(digest)) return { sha256: digest, sha256_from: "digest" };
  return { sha256: await sha256OfUrl(asset.browser_download_url, deps), sha256_from: "download" };
}

/** Pin a GitHub release: the tag (or the latest release), its x86_64 and aarch64 Linux assets. */
export async function resolveGithubReleasePin(
  input: { repo: string; tag: string | null },
  deps: PinDeps = {},
): Promise<GithubReleasePin> {
  const base = `https://api.github.com/repos/${input.repo}/releases`;
  const raw = await getJson(
    input.tag ? `${base}/tags/${encodeURIComponent(input.tag)}` : `${base}/latest`,
    deps,
  ).catch((err: unknown) => {
    if (err instanceof PinError && /^not found/.test(err.message)) {
      throw new PinError(
        input.tag
          ? `${input.repo} has no release tagged '${input.tag}'`
          : `${input.repo} has no published release with prebuilt binaries`,
      );
    }
    throw err;
  });
  const rel = GithubReleaseSchema.safeParse(raw);
  if (!rel.success) throw new PinError(`unexpected GitHub release JSON for ${input.repo}`);
  const tag = rel.data.tag_name;
  const version = versionOfTag(tag);
  const assets = {} as Record<Arch, ReleaseAssetPin>;
  for (const arch of PIN_ARCHES) {
    const name = pickReleaseAsset(rel.data.assets, arch);
    if (!name) {
      throw new PinError(
        `${input.repo} ${tag} ships no Linux ${arch} binary (assets: ${rel.data.assets
          .map((a) => a.name)
          .slice(0, 12)
          .join(", ")}); building from source is not supported yet`,
      );
    }
    const asset = rel.data.assets.find((a) => a.name === name)!;
    assets[arch] = {
      arch,
      name,
      url: asset.browser_download_url,
      ...(await assetSha256(asset, rel.data.assets, deps)),
    };
  }
  return { kind: "github_release", repo: input.repo, tag, version, assets };
}

/** Pin a GNU baseline: apt's version on the base image + the matching source tarball's sha256. */
export async function resolveGnuPin(pkg: GnuPackage, deps: PinDeps = {}): Promise<GnuPin> {
  const b = GNU_BASELINES[pkg];
  return {
    kind: "gnu",
    package: pkg,
    apt_package: b.apt_package,
    version: b.version,
    url: b.url,
    sha256: await sha256OfUrl(b.url, deps),
  };
}
