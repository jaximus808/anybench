// TDM-36 [4.4]: the template inputs behind examples/cli. The committed driver.sh, check.sh and
// do-less driver are exactly these rendered; tdm36-cli-driver.test.ts fails when they drift.
// Regenerate with: TDM36_WRITE_EXAMPLE=1 pnpm --filter @anybench/kit exec vitest run test/tdm36-cli-driver.test.ts
import {
  renderCliDoLessDriverScript,
  renderCliDriverScript,
  renderCliGateScript,
  type CliDriverTemplateInput,
} from "../src/index.js";

export const TDM36_RIPGREP: CliDriverTemplateInput = {
  contender_id: "ripgrep",
  command: [
    "args=(--no-heading --line-number --only-matching --color never)",
    "# proof overlays: MAX_COUNT (do-less first-match-only), THREADS (planted regression)",
    'if [ -n "${MAX_COUNT:-}" ]; then args+=(--max-count "$MAX_COUNT"); fi',
    'if [ -n "${THREADS:-}" ]; then args+=(--threads "$THREADS"); fi',
    'rg "${args[@]}" -e "$(cat pattern.txt)" tree',
  ].join("\n"),
  exit_codes: [0, 1],
};

export const TDM36_GNU_GREP: CliDriverTemplateInput = {
  contender_id: "gnu-grep",
  command: 'LC_ALL=C.UTF-8 grep -rnoP -e "$(cat pattern.txt)" tree',
  exit_codes: [0, 1],
};

/** Kit-relative path -> rendered content, for every generated file in examples/cli. */
export function tdm36ExampleFiles(): Record<string, string> {
  return {
    "adapters/ripgrep/driver.sh": renderCliDriverScript(TDM36_RIPGREP),
    "adapters/gnu-grep/driver.sh": renderCliDriverScript(TDM36_GNU_GREP),
    "proof/do_less/truncate/driver.sh": renderCliDoLessDriverScript(TDM36_RIPGREP, {
      keep_lines: 1,
    }),
    "gates/same-matches/check.sh": renderCliGateScript({
      gate_id: "same-matches",
      reference: "reference/same-matches/",
      sort_lines: true,
      exit_codes: [0, 1],
    }),
  };
}
