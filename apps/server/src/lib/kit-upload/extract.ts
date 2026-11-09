// TDM-217 [19.1]: write a checked kit archive (archive.ts) into a fresh temp directory, validate
// it with @anybench/kit validateKitDir, hash its tree, and remove the directory again.
//
// Defense in depth on top of the reader's path checks: the directory comes from mkdtemp (0700,
// random name, nothing in it), only regular files and directories are created, every target is
// re-resolved and must stay inside the directory, and files are opened with O_CREAT|O_EXCL
// (`wx`), which never follows an existing path (so never a symlink) and never overwrites.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashKitPaths, validateKitDir, type KitIssue, type KitValidation } from "@anybench/kit";
import { KitArchiveError, type KitArchive } from "./archive.js";

function inside(root: string, rel: string): string {
  const abs = path.resolve(root, ...rel.split("/"));
  const back = path.relative(root, abs);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) {
    throw new KitArchiveError(
      "unsafe_path",
      `entry ${JSON.stringify(rel)} resolves outside the kit`,
    );
  }
  return abs;
}

/** Write `archive` under `root` (an empty directory). */
export async function writeKitArchive(archive: KitArchive, root: string): Promise<void> {
  for (const d of [...archive.dirs].sort()) {
    await mkdir(inside(root, d), { recursive: true, mode: 0o755 });
  }
  for (const f of archive.files) {
    const abs = inside(root, f.path);
    await mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
    await writeFile(abs, f.data, { flag: "wx", mode: f.mode });
    await chmod(abs, f.mode); // the process umask may have cleared bits
  }
}

export interface CheckedKit {
  validation: KitValidation;
  /** sha256 of the whole kit tree (hashKitPaths over the root): the kit row's `hash`. */
  treeHash: string;
}

/** Replace the temp directory in issue text, so messages read as kit-relative. */
function scrub(issue: KitIssue, root: string): KitIssue {
  const fix = (s: string) => s.split(root).join("<kit>");
  return { ...issue, file: fix(issue.file), message: fix(issue.message) };
}

/**
 * Extract `archive` into a fresh temp dir, validate it, hash it, and always remove the dir. The
 * validation's issues have the temp path scrubbed; `validation.kit` (absolute paths into the
 * removed dir) must not be used after this returns.
 */
export async function checkKitArchive(archive: KitArchive): Promise<CheckedKit> {
  const root = await mkdtemp(path.join(tmpdir(), "anybench-kit-upload-"));
  try {
    await writeKitArchive(archive, root);
    const v = await validateKitDir(root);
    const { hash } = await hashKitPaths(root, [""]);
    const validation: KitValidation = {
      ...v,
      errors: v.errors.map((i) => scrub(i, root)),
      warnings: v.warnings.map((i) => scrub(i, root)),
      lines: v.lines.map((l) => l.split(root).join("<kit>")),
    };
    return { validation, treeHash: hash.sha256 };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
