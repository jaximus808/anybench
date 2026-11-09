// TDM-232 [18.11]: the frozen-workspace fact the executor records when a runner ends
// (core FrozenWorkspaceSchema), and which ended trials trial.gate grades.
//
// A failed_subject trial (wall-clock or token cap, driver exit non-zero after work) whose
// attempt froze a workspace is graded on it like a `collecting` trial; it keeps its outcome. An
// infra failure never gets here (no manifest: the computer died before the freeze), and stays
// excluded, retried and unbilled.
import {
  FROZEN_RUNNER_OWN_FILES,
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
});

const OWN = new Set<string>(FROZEN_RUNNER_OWN_FILES);

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
  const workspace = m.data.files.filter((f) => !OWN.has(f.path)).length;
  const base = {
    manifest: true,
    files,
    workspace_files: workspace,
    frozen_at: m.data.frozen_at ?? null,
  };
  if (workspace === 0) {
    return none("the manifest lists only the runner's own logs and probes", base);
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
