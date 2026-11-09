// TDM-248 [21.8]: frozen.ts counts only workspace/** as the frozen workspace, reads the runner's
// own freeze (manifest `workspace_freeze`), and core workspaceLostByInfra tells a workspace our
// runner lost (not graded, never 0) from one the subject left empty or never froze.
import { NOT_GRADED_INFRA, subjectFailureNote, workspaceLostByInfra } from "@anybench/core";
import { describe, expect, it } from "vitest";
import { frozenWorkspaceFromManifest, gradesFrozenWorkspace } from "../src/frozen.js";

/** Run 01a1c202's B manifest: the token cap killed the driver before it copied the workspace. */
const B_MANIFEST_TDM248 = {
  trial_id: "t",
  attempt: 1,
  frozen_at: "2026-11-08T21:32:05.343Z",
  files: [
    { path: "claude.stderr.log" },
    { path: "machine.json" },
    { path: "stderr.log" },
    { path: "stdout.log" },
    { path: "stream.jsonl" },
    { path: "versions.json" },
  ],
};

describe("frozenWorkspaceFromManifest counts only workspace/ (TDM-248)", () => {
  it("run 01a1c202's B manifest (6 files, no workspace/) is not present and not graded", () => {
    const f = frozenWorkspaceFromManifest(B_MANIFEST_TDM248, 1);
    expect(f).toEqual({
      present: false,
      manifest: true,
      files: 6,
      workspace_files: 0,
      frozen_at: "2026-11-08T21:32:05.343Z",
      grading: "none",
      reason: "the manifest lists no workspace/ files",
    });
    expect(gradesFrozenWorkspace({ state: "failed_subject", frozen_workspace: f })).toBe(false);
  });

  it("artifacts/ and the driver's top-level files are not the workspace; workspace/** is", () => {
    const f = frozenWorkspaceFromManifest(
      {
        ...B_MANIFEST_TDM248,
        files: [
          ...B_MANIFEST_TDM248.files,
          { path: "artifacts/progress.txt" },
          { path: "workspace-notes.txt" },
          { path: "workspace/package.json" },
          { path: "workspace/src/app.ts" },
        ],
      },
      1,
    );
    expect(f).toMatchObject({ present: true, files: 10, workspace_files: 2, grading: "pending" });
    expect(f.runner_froze).toBeUndefined();
  });

  it("records the runner's own freeze, an empty one, and a failed one", () => {
    const froze = {
      by: "runner",
      trigger: "budget",
      dir: "workspace",
      files: 2,
      bytes: 9,
      skipped: 0,
    };
    const withWs = frozenWorkspaceFromManifest(
      {
        ...B_MANIFEST_TDM248,
        files: [...B_MANIFEST_TDM248.files, { path: "workspace/a" }, { path: "workspace/b" }],
        workspace_freeze: { ...froze, error: null },
      },
      1,
    );
    expect(withWs).toMatchObject({ present: true, workspace_files: 2, runner_froze: true });

    const empty = frozenWorkspaceFromManifest(
      { ...B_MANIFEST_TDM248, workspace_freeze: { ...froze, files: 0, error: null } },
      1,
    );
    expect(empty).toMatchObject({
      present: false,
      grading: "none",
      runner_froze: true,
      reason: "the runner froze the workspace after stopping the subject, and it was empty",
    });

    const failed = frozenWorkspaceFromManifest(
      { ...B_MANIFEST_TDM248, workspace_freeze: { ...froze, files: 0, error: "ENOSPC" } },
      1,
    );
    expect(failed).toMatchObject({ present: false, grading: "none", runner_froze: false });
  });
});

describe("workspaceLostByInfra (TDM-248)", () => {
  const none = frozenWorkspaceFromManifest(B_MANIFEST_TDM248, 1);
  const runnerEmpty = frozenWorkspaceFromManifest(
    {
      ...B_MANIFEST_TDM248,
      workspace_freeze: { by: "runner", trigger: "budget", files: 0, error: null },
    },
    1,
  );
  const graded = {
    ...frozenWorkspaceFromManifest({ files: [{ path: "workspace/a" }] }, 1),
    grading: "graded",
  };

  it("is true only for our stop with nothing frozen, or a legacy 'no workspace/' verdict", () => {
    const lost = (over: Partial<Parameters<typeof workspaceLostByInfra>[0]>) =>
      workspaceLostByInfra({
        state: "failed_subject",
        failureClass: "budget",
        frozen: none,
        ...over,
      });
    expect(lost({})).toBe(true);
    expect(lost({ failureClass: "wall_clock_exceeded" })).toBe(true);
    expect(lost({ failureClass: "wall_clock" })).toBe(true);
    // The subject ended itself: its fail.
    expect(lost({ failureClass: "run_failed" })).toBe(false);
    expect(lost({ failureClass: null })).toBe(false);
    // Not a subject failure at all.
    expect(lost({ state: "done" })).toBe(false);
    expect(lost({ state: "failed_infra" })).toBe(false);
    // The runner froze it, and the subject had left nothing: a fail, not ours.
    expect(lost({ frozen: runnerEmpty })).toBe(false);
    // Trials from before TDM-232 carry no fact: unchanged.
    expect(lost({ frozen: null })).toBe(false);
    // Our scoring could not grade it: TDM-232's fail with no partial credit (a contender could
    // provoke that), not this.
    expect(lost({ frozen: { ...graded, grading: "unavailable", reason: "no bundle" } })).toBe(
      false,
    );
    // Legacy (run 01a1c202): "graded" on the driver's logs, the gate found no workspace/.
    const legacy = { frozen: graded, gateReasons: ["the outputs have no workspace/"] };
    expect(lost(legacy)).toBe(true);
    expect(lost({ ...legacy, hiddenTestFraction: 0 })).toBe(false);
    expect(lost({ frozen: graded, gateReasons: ["0/120 hidden tests pass"] })).toBe(false);
  });

  it("the trial note says why it is not graded", () => {
    expect(subjectFailureNote({ failureClass: "budget", frozen: none })).toBe(
      `stopped at the token cap; ${NOT_GRADED_INFRA}`,
    );
    expect(subjectFailureNote({ failureClass: "budget", frozen: runnerEmpty })).toBe(
      "stopped at the token cap; its workspace was frozen empty, counted as a fail",
    );
    expect(subjectFailureNote({ failureClass: "run_failed", frozen: none })).toBe(
      "its driver exited non-zero; no frozen workspace to grade, counted as a fail",
    );
  });
});
