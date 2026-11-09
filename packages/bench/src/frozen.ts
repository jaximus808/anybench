// TDM-232 [18.11]: the frozen-workspace fact the executor records when a runner ends
// (core FrozenWorkspaceSchema), and which ended trials trial.gate grades.
//
// A failed_subject trial (wall-clock or token cap, driver exit non-zero after work) whose
// attempt froze a workspace is graded on it like a `collecting` trial; it keeps its outcome. An
// infra failure never gets here (no manifest: the computer died before the freeze), and stays
// excluded, retried and unbilled.
//
// TDM-248: only files under workspace/ count as the workspace. Before, every file that was not
// the runner's own counted, so a coding-agent driver's stream.jsonl, versions.json and
// claude.stderr.log read as "3 workspace files, present" and the gate graded nothing.
import {
  FROZEN_WORKSPACE_DIR,
  frozenWorkspaceOf,
  type FrozenWorkspace,
  type TrialState,
} from "@anybench/core";
import { z } from "zod";

/** The runner's manifest.json (packages/runner runner.ts freeze), as far as this reads it. */
const ManifestSchema = z.object({
  attempt: z.int().positive().optional(),
  frozen_at: z.string().optional(),
  files: z.array(z.object({ path: z.string().min(1) })),
  /** TDM-248: the runner froze EVAL_WS itself after it stopped the subject (runner freeze-ws.ts). */
  workspace_freeze: z
    .object({ by: z.literal("runner"), error: z.string().nullable().optional() })
    .optional(),
});

const WORKSPACE_PREFIX = `${FROZEN_WORKSPACE_DIR}/`;

/**
 * manifest.json (parsed JSON, or null when absent) → the fact. A manifest from another attempt
 * counts as absent. `grading` is `pending` when a workspace was frozen, else `none`.
 */
export function frozenWorkspaceFromManifest(raw: unknown, attempt: number): FrozenWorkspace {
  const none = (reason: string, extra: Partial<FrozenWorkspace> = {}): FrozenWorkspace => ({
    present: false,
    manifest: false,
    files: 0,
    workspace_files: 0,
    frozen_at: null,
    grading: "none",
    reason,
    ...extra,
  });
  if (raw === null || raw === undefined) return none("no manifest.json for this attempt");
  const m = ManifestSchema.safeParse(raw);
  if (!m.success) return none("manifest.json does not parse");
  if (m.data.attempt !== undefined && m.data.attempt !== attempt) {
    return none(`manifest.json is from attempt ${m.data.attempt}, not ${attempt}`);
  }
  const files = m.data.files.length;
  const workspace = m.data.files.filter((f) => f.path.startsWith(WORKSPACE_PREFIX)).length;
  const freeze = m.data.workspace_freeze;
  const base = {
    manifest: true,
    files,
    workspace_files: workspace,
    frozen_at: m.data.frozen_at ?? null,
    ...(freeze ? { runner_froze: !freeze.error } : {}),
  };
  if (workspace === 0) {
    return none(
      freeze && !freeze.error
        ? "the runner froze the workspace after stopping the subject, and it was empty"
        : `the manifest lists no ${WORKSPACE_PREFIX} files`,
      base,
    );
  }
  return { present: true, ...base, grading: "pending" };
}

/** An ended trial trial.gate must grade: failed_subject with a frozen workspace not graded yet. */
export function gradesFrozenWorkspace(t: {
  state: TrialState;
  frozen_workspace?: unknown;
}): boolean {
  return (
    t.state === "failed_subject" && frozenWorkspaceOf(t.frozen_workspace)?.grading === "pending"
  );
}
