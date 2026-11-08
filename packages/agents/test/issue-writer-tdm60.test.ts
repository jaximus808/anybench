// TDM-60 [6.6] step 6: the issue writer's input is screened in code (no test ids, test paths,
// commit, assertion source or long literals reach the model).
import type { MinedTask } from "@anybench/kit";
import { describe, expect, it } from "vitest";
import {
  buildIssueWriterInput,
  loadRole,
  renderIssueInstruction,
  screenSymptoms,
} from "../src/index.js";

const TASK = {
  id: "mined-0123456789",
  area: "src",
  source: { commit: "abcdef1234567890abcdef1234567890abcdef12", parent: "0".repeat(40) },
  files: {
    test_files: [{ path: "test/truncate.test.js" }],
    fix_files: [{ path: "src/strings.js" }],
  },
  runner: { kind: "node-test" },
  fail_to_pass: ["test/truncate.test.js > truncate keeps short strings untouched"],
  pass_to_pass: [],
  symptoms: [
    {
      test: "test/truncate.test.js > truncate keeps short strings untouched",
      message: [
        "TypeError: truncate is not a function",
        "    at TestContext.<anonymous> (/w/test/truncate.test.js:4:10)",
        "assert.equal(truncate('hello', 10), 'hello')",
        "Expected 'this is a very long expected value copied from the hidden assertion'",
        "failing test: truncate keeps short strings untouched (commit abcdef1)",
      ].join("\n"),
    },
  ],
} as unknown as MinedTask;

describe("issue writer (TDM-60)", () => {
  it("screens the symptoms in code", () => {
    const s = screenSymptoms(TASK);
    expect(s).toHaveLength(1);
    const text = s[0]!;
    expect(text).toContain("TypeError: truncate is not a function");
    for (const bad of [
      "truncate.test.js",
      "keeps short strings untouched",
      "abcdef1",
      "assert.equal",
      "copied from the hidden assertion",
      "TestContext",
    ])
      expect(text).not.toContain(bad);
  });

  it("builds a bounded input with no test names and renders instruction.md", () => {
    const m = buildIssueWriterInput({
      task: TASK,
      repo: { name: "x", summary: "y" },
      readmeExcerpt: "r".repeat(9000),
    });
    expect(JSON.stringify(m)).not.toContain("keeps short strings");
    expect((m.readme_excerpt as string).length).toBe(4000);
    expect(
      renderIssueInstruction({ title: " T ", body: "B", underspecified: false, why: "" }),
    ).toBe("# T\n\nB\n");
    expect(loadRole("issue-writer").config.budget.max_task_micro_usd).toBe(50_000n);
  });
});
