// TDM-186 [16.15]: the read-only git plumbing the task miner needs on a local clone.
//
// Everything is read from objects (`ls-tree`, `cat-file --batch`), never from a checkout, so the
// clone is never written and `.gitattributes` export-ignore rules (which `git archive` honours and
// many repos set on test/) cannot silently drop the very files we mine.
import { spawn } from "node:child_process";

export class MineGitError extends Error {
  override readonly name = "MineGitError";
}

const SHA_RE = /^[a-f0-9]{40}$/;
const MAX_STDOUT = 512 * 1024 * 1024;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    // Paths we pass are file names, never globs.
    GIT_LITERAL_PATHSPECS: "1",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  for (const k of Object.keys(env))
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  // Local reads only: no transport may run (a promisor remote would otherwise lazily fetch).
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "protocol.allow";
  env.GIT_CONFIG_VALUE_0 = "never";
  return env;
}

export async function gitBuffer(
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      env: gitEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > MAX_STDOUT) {
        child.kill("SIGKILL");
        return;
      }
      out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => reject(new MineGitError(`could not run git: ${e.message}`)));
    child.on("close", (code) => {
      if (bytes > MAX_STDOUT) {
        reject(new MineGitError(`git ${args[0]} printed more than ${MAX_STDOUT} bytes`));
        return;
      }
      if (code !== 0) {
        const msg = Buffer.concat(err).toString("utf8").trim().slice(0, 500);
        reject(new MineGitError(`git ${args.slice(0, 2).join(" ")} failed (${code}): ${msg}`));
        return;
      }
      resolve(Buffer.concat(out));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  return (await gitBuffer(cwd, args, input)).toString("utf8");
}

export async function repoTop(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
}

export async function resolveCommit(repo: string, rev: string): Promise<string> {
  if (rev.startsWith("-") || /[\s\0]/.test(rev)) throw new MineGitError(`bad rev: ${rev}`);
  const sha = (
    await git(repo, ["rev-parse", "--verify", "-q", "--end-of-options", `${rev}^{commit}`])
  ).trim();
  if (!SHA_RE.test(sha)) throw new MineGitError(`no commit at ${rev}`);
  return sha;
}

export interface TreeFile {
  path: string;
  /** git mode: 100644, 100755 or 120000 (symlink; `content` is the link target). */
  mode: string;
  sha: string;
  content: Buffer;
}

export interface TreeEntryInfo {
  path: string;
  mode: string;
  sha: string;
}

/** Every blob in `commit`'s tree (submodules skipped), optionally only `paths`. */
export async function listTree(
  repo: string,
  commit: string,
  paths?: readonly string[],
): Promise<TreeEntryInfo[]> {
  const raw = await git(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "--end-of-options",
    commit,
    ...(paths && paths.length > 0 ? ["--", ...paths] : []),
  ]);
  const out: TreeEntryInfo[] = [];
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, type, sha] = rec.slice(0, tab).split(" ");
    if (type !== "blob" || !mode || !sha) continue;
    out.push({ path: rec.slice(tab + 1), mode, sha });
  }
  return out;
}

/** Read blobs in one `cat-file --batch` call. Fails past `maxBytes` in total. */
export async function readBlobs(
  repo: string,
  entries: readonly TreeEntryInfo[],
  maxBytes: number,
): Promise<TreeFile[]> {
  if (entries.length === 0) return [];
  const sizes = await git(
    repo,
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    entries.map((e) => e.sha).join("\n") + "\n",
  );
  let total = 0;
  for (const line of sizes.split("\n")) {
    const n = Number(line.split(" ")[1]);
    if (Number.isFinite(n)) total += n;
    if (line.endsWith(" missing")) throw new MineGitError(`blob missing from the clone: ${line}`);
  }
  if (total > maxBytes) {
    throw new MineGitError(`tree is ${total} bytes, over the ${maxBytes}-byte cap`);
  }
  const unique = [...new Set(entries.map((e) => e.sha))];
  const buf = await gitBuffer(repo, ["cat-file", "--batch"], unique.join("\n") + "\n");
  const blobs = new Map<string, Buffer>();
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const [sha = "", , size = ""] = buf.subarray(at, nl).toString("utf8").split(" ");
    const n = Number(size);
    if (!SHA_RE.test(sha) || !Number.isInteger(n)) {
      throw new MineGitError(`unexpected cat-file output near byte ${at}`);
    }
    blobs.set(sha, buf.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return entries.map((e) => {
    const content = blobs.get(e.sha);
    if (!content) throw new MineGitError(`blob ${e.sha} not read`);
    return { ...e, content };
  });
}

export async function readTreeFiles(
  repo: string,
  commit: string,
  opts: { paths?: readonly string[]; maxBytes: number },
): Promise<TreeFile[]> {
  return readBlobs(repo, await listTree(repo, commit, opts.paths), opts.maxBytes);
}

/** One file's text at `commit`, or undefined when it is absent there. */
export async function readTextAt(
  repo: string,
  commit: string,
  path: string,
): Promise<string | undefined> {
  const [entry] = await listTree(repo, commit, [path]);
  if (!entry || entry.path !== path) return undefined;
  const [file] = await readBlobs(repo, [entry], 8 * 1024 * 1024);
  return file?.content.toString("utf8");
}
