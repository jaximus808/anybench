// TDM-60 [6.6] step 6: the generated kit for a coding-agent or harness repo.
//
//   designMinedAgentKit({db, client}, ctx, {repoDir, tasks, template, ...})
//     1. one issue-writer session per mined task (packages/agents/issue-writer), on the task's
//        SCREENED symptoms only (screenSymptoms: no test ids, test paths, commit, assertion
//        source, long literals), never the diff;
//     2. drops: the writer said underspecified; the issue names a FAIL_TO_PASS / PASS_TO_PASS
//        test, a hidden test path or the upstream commit;
//     3. materializeAgentKit (mined gate, oracle = the fix, noop + partial-oracle do-less,
//        contenders pinned from the template kit; checkMinedTaskLeaks again on the written
//        files) and validateGeneratedKit (loadKit + comparability + no-leak lint).
//   The orchestrator's designKit still holds agent/harness repos: mining needs a clone with
//   history and a verification computer per candidate on the worker (follow-up). This function is
//   what that path will call, and what the live Tandem run calls directly.
import {
  buildIssueWriterInput,
  ISSUE_WRITER_ROLE,
  IssueWriterOutputSchema,
  renderIssueInstruction,
} from "@anybench/agents";
import type { KitSpec } from "@anybench/core";
import {
  materializeAgentKit,
  MaterializeError,
  MineLeakError,
  validateGeneratedKit,
  type MaterializeAgentKitInput,
  type MinedTask,
} from "@anybench/kit";
import type { NaiveClient } from "@anybench/naive";
import type { Database } from "../db/client.js";
import { runAgentStage } from "../jobs/agent-session.js";
import type { StageContext } from "./ports.js";

/** Per issue-writer session, integer micro-USD ($0.05). */
export const ISSUE_WRITER_BUDGET_MICRO_USD = 50_000n;

export interface MinedAgentKitInput {
  repoDir: string;
  tasks: MinedTask[];
  repo: { name: string; summary: string };
  readmeExcerpt?: string;
  subject: MaterializeAgentKitInput["subject"];
  template: MaterializeAgentKitInput["template"];
  dir: string;
  budgetPerIssueMicroUsd?: bigint;
  model?: string;
}

export type MinedAgentKitResult =
  | {
      ok: true;
      spec: KitSpec;
      dir: string;
      kept: string[];
      dropped: { id: string; why: string }[];
      costMicroUsd: bigint;
      warnings: string[];
    }
  | { ok: false; reason: string; dropped: { id: string; why: string }[]; costMicroUsd: bigint };

/** Does the issue point at the hidden tests or the fix? (cheap, before materializing) */
export function issueLeaks(task: MinedTask, text: string): string | null {
  const lower = text.toLowerCase();
  for (const id of [...task.fail_to_pass, ...task.pass_to_pass]) {
    const leaf =
      id
        .split(/\s*>\s*|::/)
        .pop()
        ?.trim() ?? "";
    if (id.length >= 6 && lower.includes(id.toLowerCase())) return `names the test '${id}'`;
    if (leaf.length >= 12 && lower.includes(leaf.toLowerCase())) return `names the test '${leaf}'`;
  }
  for (const f of task.files.test_files)
    if (lower.includes(f.path.toLowerCase())) return `names the hidden test file ${f.path}`;
  if (lower.includes(task.source.commit.slice(0, 7))) return "names the upstream commit";
  return null;
}

export async function designMinedAgentKit(
  deps: { db: Database; client: NaiveClient },
  ctx: StageContext,
  input: MinedAgentKitInput,
): Promise<MinedAgentKitResult> {
  const dropped: { id: string; why: string }[] = [];
  const kept: { task: MinedTask; instruction: string }[] = [];
  let cost = 0n;
  for (const task of input.tasks) {
    const r = await runAgentStage(deps, {
      ctx: { ...ctx, idempotencyKey: `${ctx.idempotencyKey}:issue:${task.id}` },
      role: ISSUE_WRITER_ROLE,
      input: buildIssueWriterInput({
        task,
        repo: input.repo,
        ...(input.readmeExcerpt ? { readmeExcerpt: input.readmeExcerpt } : {}),
      }),
      schema: IssueWriterOutputSchema,
      budgetMicroUsd: input.budgetPerIssueMicroUsd ?? ISSUE_WRITER_BUDGET_MICRO_USD,
      ...(input.model ? { agent: { overrides: { model: input.model } } } : {}),
    });
    if (!r.ok) {
      dropped.push({ id: task.id, why: `issue writer: ${r.reason}` });
      continue;
    }
    cost += r.value.costMicroUsd;
    const o = r.value.output;
    if (o.underspecified) {
      dropped.push({ id: task.id, why: `underspecified: ${o.why}` });
      continue;
    }
    const instruction = renderIssueInstruction(o);
    const leak = issueLeaks(task, instruction);
    if (leak) {
      dropped.push({ id: task.id, why: `the issue ${leak}` });
      continue;
    }
    kept.push({ task, instruction });
  }
  if (kept.length === 0)
    return {
      ok: false,
      reason: "no mined task survived issue writing and screening",
      dropped,
      costMicroUsd: cost,
    };
  // Materialize + validate. An instruction the no-leak lint flags (it names a hidden test or
  // quotes its expected value) drops that task, and the kit is written again without it.
  let v: Awaited<ReturnType<typeof validateGeneratedKit>> | null = null;
  for (let round = 0; round < 3; round++) {
    if (kept.length === 0)
      return {
        ok: false,
        reason: "no mined task survived the no-leak lint",
        dropped,
        costMicroUsd: cost,
      };
    try {
      await materializeAgentKit({
        repoDir: input.repoDir,
        dir: input.dir,
        subject: input.subject,
        tasks: kept,
        template: input.template,
        provenance: { run_id: ctx.run.id, dropped },
      });
    } catch (err) {
      if (err instanceof MaterializeError || err instanceof MineLeakError)
        return { ok: false, reason: err.message, dropped, costMicroUsd: cost };
      throw err;
    }
    v = await validateGeneratedKit(input.dir);
    if (v.ok && v.kit) break;
    const leaking = new Map<string, string>();
    for (const issue of v.issues) {
      const m = /^workloads\/(mined-[a-f0-9]{10})\/instruction\.md: (.*)$/.exec(issue);
      if (m) leaking.set(m[1]!, m[2]!);
    }
    // Only instruction leaks are dropped and retried; any other issue is the kit's, not a task's.
    if (
      leaking.size === 0 ||
      v.issues.some((i) => !/^workloads\/mined-[a-f0-9]{10}\/instruction\.md: /.test(i))
    )
      break;
    for (const [id, why] of leaking) {
      const at = kept.findIndex((k) => k.task.id === id);
      if (at < 0) continue;
      dropped.push({ id, why: `the issue ${why}` });
      kept.splice(at, 1);
    }
  }
  if (!v || !v.ok || !v.kit)
    return {
      ok: false,
      reason: `the generated agent kit does not validate: ${(v?.issues ?? []).slice(0, 6).join("; ")}`,
      dropped,
      costMicroUsd: cost,
    };
  return {
    ok: true,
    spec: v.kit.spec,
    dir: input.dir,
    kept: kept.map((k) => k.task.id),
    dropped,
    costMicroUsd: cost,
    warnings: v.warnings,
  };
}
