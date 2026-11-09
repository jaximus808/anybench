// TDM-248 [21.8]: the runner freezes the workspace itself when it stopped the subject.
//
// A coding-agent driver copies EVAL_WS into EVAL_OUT/workspace/ after its agent exits (the
// hidden-tests gate reads that copy). When the runner kills the driver's process group at the
// token cap, the run's budget stop (TDM-242) or the wall-clock cap, the driver never gets there,
// and the trial loses its work (harness league run 1: every "Claude Code + subagents" trial was
// graded on nothing). So after such a stop the runner makes that copy: EVAL_WS's regular files,
// without .git and node_modules (as the drivers' `tar --exclude` does), replacing any partial copy
// the driver left. It records what it did in manifest.json (`workspace_freeze`), so the server can
// tell "the subject left nothing" (runner froze, 0 files) from "our infra lost it" (no freeze).

import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Where the frozen copy goes, relative to EVAL_OUT (the convention every workspace gate reads). */
export const STOP_FREEZE_DIR = "workspace";
/** Directory names left out at any depth (the kit drivers' `tar --exclude=.git --exclude=node_modules`). */
export const STOP_FREEZE_EXCLUDE: readonly string[] = [".git", "node_modules"];

/** Why the runner stopped the subject's verb. */
export type SubjectStop = "budget" | "wall_clock";

/** manifest.json `workspace_freeze`: what the runner froze after it stopped the subject. */
export interface WorkspaceFreeze {
  by: "runner";
  trigger: SubjectStop;
  /** Relative to EVAL_OUT. */
  dir: string;
  files: number;
  bytes: number;
  /** Files left out: unreadable, or past the transfer cap. */
  skipped: number;
  /** Set when the freeze itself failed part-way (the copy may be incomplete). */
  error: string | null;
}

/**
 * Copy `wsDir`'s regular files into `destDir` (removed first). Symlinks are skipped, as in the
 * bundle (glob.ts listFiles). Files that would take the copy past `maxBytes` are skipped, not
 * truncated. Never throws: a failure is in `error`.
 */
export async function freezeWorkspace(
  wsDir: string,
  destDir: string,
  opts: { trigger: SubjectStop; dir: string; maxBytes: number },
): Promise<WorkspaceFreeze> {
  const result: WorkspaceFreeze = {
    by: "runner",
    trigger: opts.trigger,
    dir: opts.dir,
    files: 0,
    bytes: 0,
    skipped: 0,
    error: null,
  };
  const exclude = new Set(STOP_FREEZE_EXCLUDE);
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(wsDir, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (exclude.has(e.name)) continue;
        try {
          await walk(r);
        } catch {
          result.skipped++; // an unreadable directory
        }
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = await lstat(join(wsDir, r));
        if (result.bytes + st.size > opts.maxBytes) {
          result.skipped++;
          continue;
        }
        const dest = join(destDir, r);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(wsDir, r), dest);
        result.files++;
        result.bytes += st.size;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
          result.skipped++;
          continue;
        }
        throw err;
      }
    }
  };
  try {
    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });
    await walk("");
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}
