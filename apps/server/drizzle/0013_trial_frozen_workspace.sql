-- TDM-232 [18.11]: a trial records whether its attempt froze a workspace (the runner's
-- manifest.json, read by the worker when the runner ended) and what grading did with it. A
-- failed_subject trial with a frozen workspace is graded on it and keeps its outcome.
ALTER TABLE "trials" ADD COLUMN "frozen_workspace" jsonb;
