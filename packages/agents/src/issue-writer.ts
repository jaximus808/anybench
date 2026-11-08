// TDM-60 [6.6] step 6: the issue writer role (packages/agents/issue-writer/) as typed code.
//
//   screenSymptoms(task)        the failing tests' output, screened IN CODE before any model sees
//                               it: test ids, test file paths, the upstream commit, assertion
//                               source lines and long quoted literals are removed; messages are
//                               cut to their first lines.
//   buildIssueWriterInput(...)  repo summary + area + runner kind + README excerpt + screened
//                               symptoms. Never the diff, never a test name.
//   IssueWriterOutputSchema     {title, body, underspecified, why}.
//   renderIssueInstruction(o)   instruction.md. The caller still runs checkMinedTaskLeaks and the
//                               no-leak lint on the written kit (materializeAgentKit does).
import type { MinedTask } from "@anybench/kit";
import { z } from "zod";

export const ISSUE_WRITER_ROLE = "issue-writer";

export const IssueWriterOutputSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4_000),
  underspecified: z.boolean(),
  why: z.string().default(""),
});
export type IssueWriterOutput = z.infer<typeof IssueWriterOutputSchema>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Screened symptoms: what a user could observe, with every pointer to the hidden tests removed. */
export function screenSymptoms(task: MinedTask, max = 6): string[] {
  const banned = [
    ...task.fail_to_pass,
    ...task.pass_to_pass,
    ...task.files.test_files.map((f) => f.path),
    task.source.commit,
    task.source.commit.slice(0, 7),
  ]
    .flatMap((s) => [s, ...s.split(/\s*>\s*|::/)])
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length);
  const out: string[] = [];
  for (const s of task.symptoms.slice(0, max)) {
    let text = s.message
      .split("\n")
      .filter((l) => !/^\s*(at |File "|\d+\s*\||>\s|E\s+(assert|where)\b)/.test(l))
      .filter((l) => !/\b(assert|expect|t\.(equal|is|deepEqual)|require\(|import )/.test(l))
      .slice(0, 4)
      .join("\n");
    for (const b of banned) text = text.replace(new RegExp(escapeRe(b), "g"), "[withheld]");
    text = text
      .replace(/(["'`])[^"'`\n]{40,}\1/g, "[long literal withheld]")
      .replace(/\S*\/(tests?|__tests__|spec)\/\S*/g, "[test path withheld]")
      .trim();
    if (text.length > 0 && !out.includes(text)) out.push(text.slice(0, 600));
  }
  return out;
}

export function buildIssueWriterInput(a: {
  task: MinedTask;
  repo: { name: string; summary: string };
  readmeExcerpt?: string;
}): Record<string, unknown> {
  return {
    repo: a.repo,
    area: a.task.area,
    runner: a.task.runner.kind,
    readme_excerpt: (a.readmeExcerpt ?? "").slice(0, 4_000),
    symptoms: screenSymptoms(a.task),
  };
}

/** instruction.md from the writer's answer. */
export function renderIssueInstruction(o: IssueWriterOutput): string {
  return `# ${o.title.trim()}\n\n${o.body.trim()}\n`;
}
