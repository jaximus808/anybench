// TDM-39 [4.7]: the template inputs behind examples/coding-agent. The committed driver.sh, do-less
// driver and check.sh are exactly these rendered; tdm39-coding-agent.test.ts fails when they drift.
// Regenerate with: TDM39_WRITE_EXAMPLE=1 pnpm --filter @anybench/kit exec vitest run test/tdm39-coding-agent.test.ts
import {
  renderCodingAgentDoLessDriverScript,
  renderCodingAgentDriverScript,
  renderCodingAgentGateScript,
  type CodingAgentDriverTemplateInput,
} from "../src/index.js";

export const TDM39_CLAUDE_CODE: CodingAgentDriverTemplateInput = {
  contender_id: "claude-code",
  claude_code_version: "2.1.319",
  setup_dir: "adapters/claude-code",
};

/** Kit-relative path -> rendered content, for every generated file in examples/coding-agent. */
export function tdm39ExampleFiles(): Record<string, string> {
  return {
    "adapters/claude-code/driver.sh": renderCodingAgentDriverScript(TDM39_CLAUDE_CODE),
    "proof/do_less/skip-tests/driver.sh": renderCodingAgentDoLessDriverScript(TDM39_CLAUDE_CODE),
    "gates/hidden-tests/check.sh": renderCodingAgentGateScript({
      gate_id: "hidden-tests",
      min_tests: 7,
    }),
  };
}
