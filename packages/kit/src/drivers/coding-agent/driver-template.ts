// TDM-39 [4.7]: `adapters/<id>/driver.sh` for `driver.type: coding-agent` (headless Claude Code).
//
// The rendered driver implements the L2 verbs (start | ready | stop are no-ops; run <task>
// <workspace>) and, for `run`:
//   1. resolves the pins (Claude Code version, model) and refuses anything that is not exact;
//   2. switches to the non-root eval user and gives it copies of the workspace, the task and the
//      contender's Claude Code config (CLAUDE.md + .claude/ as user-level config under its HOME,
//      so nothing lands in the graded workspace), and each secret as a 0600 file;
//   3. checks `claude --version` against the pin and writes versions.json;
//   4. runs `claude -p "$(cat instruction.md)" --output-format stream-json --verbose --model <pin>
//      --dangerously-skip-permissions [--max-turns N] [--disallowedTools ...]` in the workspace,
//      with the stream redacted and teed to stdout (the runner meters it for the BYOK token cap)
//      and to EVAL_OUT/stream.jsonl (the stream-json collector);
//   5. kills what the agent left running, freezes the workspace to EVAL_OUT/workspace for the
//      hidden tests on the scoring computer (and copies it back to EVAL_WS for `collect` globs),
//      and checks the stream's init event against the pins.
// The run verb exits with Claude Code's status, or 1 when the driver refused the trial (the
// reason is in EVAL_OUT/coding-agent/error.txt).
//
// The do-less variant differs only in its baked settings: a CLAUDE.md that says "skip the tests"
// appended to the config, and a 3-turn cap. It must fail the hidden tests.
import { CLI_SCRIPT_SHEBANG, shQuote } from "../cli/shell.js";
import {
  BASH_CLAUDE_LAUNCHER,
  BASH_EVAL_USER,
  BASH_FAIL,
  BASH_FREEZE_WORKSPACE,
  BASH_KILL_EVAL,
  BASH_PIN_PREDICATES,
  BASH_REDACT,
  BASH_SECRETS,
  BASH_STREAM_INIT,
  CLAUDE_CODE_RUN_ENV,
  CODING_AGENT_GENERATED_MARKER,
  DEFAULT_TOKEN_SOURCE,
  TOKEN_SOURCE_ENV,
  TOKEN_SOURCES,
} from "./claude-code.js";
import {
  CodingAgentDoLessSchema,
  CodingAgentDriverTemplateSchema,
  type CodingAgentDoLess,
  type CodingAgentDoLessInput,
  type CodingAgentDriverTemplate,
  type CodingAgentDriverTemplateInput,
} from "./options.js";
import { CODING_AGENT_OUTPUT_PATHS as P } from "./outputs.js";

/** A heredoc delimiter that cannot appear in the text. */
function heredocTag(text: string): string {
  let tag = "ANYBENCH_DO_LESS_CLAUDE_MD";
  while (text.split("\n").includes(tag)) tag += "_";
  return tag;
}

const RUN = `run_agent() {
  local task="\${1:?usage: driver.sh run <task> <workspace>}"
  local ws="\${2:-\${EVAL_WS:-}}"
  [ -n "$ws" ] || die_usage "usage: driver.sh run <task> <workspace> (or set EVAL_WS)"
  out="\${EVAL_OUT:-}"
  [ -n "$out" ] || die_usage "EVAL_OUT is not set"
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
  rm -rf "$out/coding-agent" "$out/${P.stream}" "$out/${P.versions}" "$out/${P.workspace}"
  mkdir -p "$out/coding-agent"
  [ -f "$task" ] || fail "task file not found: $task"
  [ -d "$ws" ] || fail "workspace not found: $ws"
  ws="$(cd "$ws" && pwd)"
  command -v node > /dev/null || fail "node is not on PATH (the agent-cc profile installs it)"

  # 1. Pins (plan.md 17.2 rule 4): baked into this driver, else from the kit (versions, driver.model).
  local cc_version="$pinned_cc_version" model="$pinned_model"
  if [ -n "$cc_version" ]; then
    [ -z "\${CLAUDE_CODE_VERSION:-}" ] || [ "$CLAUDE_CODE_VERSION" = "$cc_version" ] ||
      fail "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION, but this driver pins Claude Code $cc_version"
  else
    cc_version="\${CLAUDE_CODE_VERSION:-}"
  fi
  [ -z "\${CC_MODEL:-}" ] || [ -z "\${ANYBENCH_MODEL:-}" ] || [ "$CC_MODEL" = "$ANYBENCH_MODEL" ] ||
    fail "CC_MODEL=$CC_MODEL disagrees with the kit's driver.model $ANYBENCH_MODEL"
  local env_model="\${CC_MODEL:-\${ANYBENCH_MODEL:-}}"
  if [ -n "$model" ]; then
    [ -z "$env_model" ] || [ "$env_model" = "$model" ] ||
      fail "the kit asks for model $env_model, but this driver pins $model"
  else
    model="$env_model"
  fi
  is_pinned_version "$cc_version" ||
    fail "Claude Code version '$cc_version' is not a pin: set versions.CLAUDE_CODE_VERSION to one release (e.g. 2.0.14)"
  is_pinned_model "$model" ||
    fail "model '$model' is not a pin: set driver.model to a dated id (e.g. claude-sonnet-4-5-20250929) or a Naïve id (e.g. anthropic/claude-sonnet-4.6)"

  # Token source (rule 4: the same for every contender): the Naïve proxy (default) or BYOK.
  token_source="\${${TOKEN_SOURCE_ENV}:-${DEFAULT_TOKEN_SOURCE}}"
  case "$token_source" in
    naive_proxy)
      case "$model" in */*) ;; *) fail "token source naive_proxy needs a Naïve model id (e.g. anthropic/claude-sonnet-4.6), not $model" ;; esac
      ;;
    anthropic_key)
      case "$model" in */*) fail "token source anthropic_key needs an Anthropic model id, not the Naïve id $model" ;; esac
      ;;
    *) fail "${TOKEN_SOURCE_ENV} must be ${TOKEN_SOURCES.join(" or ")}, not '$token_source'" ;;
  esac

  # Turn cap: the lowest of the baked cap, the kit's (CC_MAX_TURNS / ANYBENCH_MAX_TURNS), the do-less cap.
  local max_turns="" t
  for t in "$base_max_turns" "\${CC_MAX_TURNS:-}" "\${ANYBENCH_MAX_TURNS:-}" "$do_less_max_turns"; do
    [ -n "$t" ] || continue
    case "$t" in *[!0-9]* | 0*) fail "turn cap '$t' is not a positive integer" ;; esac
    if [ -z "$max_turns" ] || [ "$t" -lt "$max_turns" ]; then max_turns="$t"; fi
  done
  local token_cap=""
  for t in "$base_token_cap" "\${CC_TOKEN_CAP:-}" "\${ANYBENCH_TOKEN_CAP_TOKENS:-}"; do
    [ -n "$t" ] || continue
    case "$t" in *[!0-9]* | 0*) fail "token cap '$t' is not a positive integer" ;; esac
    if [ -z "$token_cap" ] || [ "$t" -lt "$token_cap" ]; then token_cap="$t"; fi
  done
  local disallowed="$base_disallowed \${CC_DISALLOWED_TOOLS:-}" tool tools="" tool_re='^[A-Za-z][A-Za-z0-9_]*([(][^ ()]*[)])?$'
  for tool in $disallowed; do
    tool="\${tool%,}"
    [ -n "$tool" ] || continue
    [[ $tool =~ $tool_re ]] || fail "disallowed tool '$tool' is not a tool name"
    tools="\${tools:+$tools }$tool"
  done

  # 2. The eval user, its copies, its config and its secrets.
${indentBlock(BASH_EVAL_USER, "  ")}
  local trial="$eval_home/anybench-trial"
  local eval_ws="$trial/ws" eval_task="$trial/instruction.md"
  as_eval bash -c 'rm -rf "$1" && mkdir -p "$1/ws" && chmod 700 "$1"' _ "$trial" || fail "cannot create $trial"
  tar -C "$ws" -cf - . | as_eval tar -C "$eval_ws" -xf - || fail "cannot copy the workspace to $eval_user"
  as_eval bash -c 'cat > "$1"' _ "$eval_task" < "$task" || fail "cannot copy the task to $eval_user"

  local kit="" d
  d="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
  while [ "$d" != / ]; do
    if [ -d "$d/adapters" ]; then kit="$d"; break; fi
    d="$(dirname "$d")"
  done
  local setup="$setup_dir"
  if [ -z "$setup" ] && [ -n "\${CC_SETUP:-}" ]; then
    case "$CC_SETUP" in */* | . | .. | '') fail "CC_SETUP must name one folder under adapters/" ;; esac
    setup="adapters/$CC_SETUP"
  fi
  local staging
  staging="$(mktemp -d)"
  mkdir -p "$staging/claude"
  if [ -n "$setup" ]; then
    [ -n "$kit" ] && [ -d "$kit/$setup" ] || fail "Claude Code setup $setup not found in the kit"
    if [ -d "$kit/$setup/.claude" ]; then cp -R "$kit/$setup/.claude/." "$staging/claude/"; fi
    if [ -f "$kit/$setup/CLAUDE.md" ]; then cp "$kit/$setup/CLAUDE.md" "$staging/claude/CLAUDE.md"; fi
  fi
  if [ -n "\${CLAUDE_MD_OVERLAY:-}" ]; then
    case "$CLAUDE_MD_OVERLAY" in /* | *..*) fail "CLAUDE_MD_OVERLAY must be a kit-relative path" ;; esac
    [ -n "$kit" ] && [ -f "$kit/$CLAUDE_MD_OVERLAY" ] || fail "CLAUDE_MD_OVERLAY $CLAUDE_MD_OVERLAY not found in the kit"
    { [ ! -s "$staging/claude/CLAUDE.md" ] || echo; cat "$kit/$CLAUDE_MD_OVERLAY"; } >> "$staging/claude/CLAUDE.md"
  fi
  if [ "$do_less" -eq 1 ]; then
    { [ ! -s "$staging/claude/CLAUDE.md" ] || echo; do_less_claude_md; } >> "$staging/claude/CLAUDE.md"
  fi
  tar -C "$staging/claude" -cf - . |
    as_eval bash -c 'rm -rf "$1" && mkdir -p "$1" && tar -C "$1" -xf -' _ "$eval_home/.claude" ||
    fail "cannot install the Claude Code config for $eval_user"
  rm -rf "$staging"

${indentBlock(BASH_SECRETS, "  ")}
  if [ -n "$proxy_model" ] && [ "$proxy_model" != "$model" ]; then
    fail "the proxy env file sets ANTHROPIC_MODEL=$proxy_model, but the kit pins $model"
  fi
  local effort=default thinking=default provider=anthropic
  local token_disclosed=anthropic-key
  if [ "$token_source" = naive_proxy ]; then
    token_disclosed=naive-proxy
    provider="naive:\${model%%/*}"
    # TDM-16: the proxy refuses effort, adaptive thinking and context management, so the proxy
    # env turns them off. Disclosed with every trial.
    effort=naive-min
    thinking="\${proxy_thinking:-default}"
    [ "$thinking" != 0 ] || thinking=off
  fi

  # 3. The pinned Claude Code is the one installed.
  local reported
  reported="$(as_eval claude --version 2> /dev/null | head -n 1 | tr -d '\\000-\\037"\\\\')" ||
    fail "claude is not on the eval user's PATH (install.sh installs @anybench-pinned Claude Code)"
  [ "\${reported%% *}" = "$cc_version" ] ||
    fail "claude --version says '$reported', but the kit pins Claude Code $cc_version"
  local node_version
  node_version="$(as_eval node --version 2> /dev/null | tr -d '\\000-\\037"\\\\')" || node_version=""
  printf '{"contender":"%s","claude_code":"%s","claude_code_reported":"%s","model":"%s","node":"%s","eval_user":"%s","max_turns":"%s","token_cap_tokens":"%s","disallowed_tools":"%s","token_source":"%s","provider":"%s","effort":"%s","thinking":"%s","model_capabilities":"%s","do_less":%s}\\n' \\
    "$contender" "$cc_version" "$reported" "$model" "$node_version" "$eval_user" "$max_turns" "$token_cap" "$tools" \\
    "$token_disclosed" "$provider" "$effort" "$(printf '%s' "$thinking" | tr -d '\\000-\\037"\\\\')" "$(printf '%s' "$proxy_capabilities" | tr -d '\\000-\\037"\\\\')" \\
    "$([ "$do_less" -eq 1 ] && echo true || echo false)" > "$out/${P.versions}"

  # 4. The run: stream-json redacted, teed to stdout (token meter) and to ${P.stream}.
  local args=(--output-format stream-json --verbose --model "$model" --dangerously-skip-permissions)
  [ -z "$max_turns" ] || args+=(--max-turns "$max_turns")
  [ -z "$tools" ] || args+=(--disallowedTools "$tools")
  local raw_err
  raw_err="$(mktemp)"
  set +e
  as_eval ${claudeEnvArgs()} bash -c "$claude_launcher" launcher "$secret_dir" "$eval_task" "$eval_ws" "\${args[@]}" \\
    2> "$raw_err" | redact "$token_cap" "$out/${P.tokenCap}" | tee "$out/${P.stream}"
  local status=("\${PIPESTATUS[@]}")
  set -e
  local rc="\${status[0]}"
  redact < "$raw_err" > "$out/${P.stderr}" || true
  rm -f "$raw_err"
  printf '%s\\n' "$rc" > "$out/${P.exitCode}"
  local capped=0
  if [ "\${status[1]}" -eq 3 ] && [ -f "$out/${P.tokenCap}" ]; then
    capped=1
  elif [ "\${status[1]}" -ne 0 ] || [ "\${status[2]}" -ne 0 ]; then
    fail "could not record the stream (redact/tee failed)"
  fi

  # 5. Nothing the agent left running may touch the frozen workspace; then freeze it.
  kill_eval_processes
  as_eval rm -rf "$secret_dir" || true
  freeze_workspace "$eval_ws" "$out/${P.workspace}" "$ws" || fail "could not freeze the workspace"

  local ran_model ran_version
  ran_model="$(stream_init_field "$out/${P.stream}" model)" || ran_model=""
  ran_version="$(stream_init_field "$out/${P.stream}" claude_code_version)" || ran_version=""
  if [ -n "$ran_model" ] && [ "$ran_model" != "$model" ]; then
    fail "Claude Code ran model $ran_model, but the kit pins $model"
  fi
  if [ -n "$ran_version" ] && [ "$ran_version" != "$cc_version" ]; then
    fail "the stream says Claude Code $ran_version, but the kit pins $cc_version"
  fi
  [ -n "$ran_model" ] || [ "$rc" -ne 0 ] || fail "the stream has no init event, so the model that ran is unknown"
  [ "$capped" -eq 0 ] || fail "token cap exceeded: $(cat "$out/${P.tokenCap}") (the run was stopped; the executor revokes the proxy key)"
  return "$rc"
}`;

function indentBlock(block: string, by: string): string {
  return block
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : by + l))
    .join("\n");
}

/** `env K=V ...` words for Claude Code's reproducibility env (plain values, never secrets). */
function claudeEnvArgs(): string {
  return Object.entries(CLAUDE_CODE_RUN_ENV)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

function render(t: CodingAgentDriverTemplate, doLess: CodingAgentDoLess | undefined): string {
  const title =
    doLess === undefined
      ? `L2 driver for contender '${t.contender_id}' (driver.type: coding-agent, headless Claude Code).`
      : `L7 do-less overlay for contender '${t.contender_id}' (driver.type: coding-agent): CLAUDE.md says "skip the tests", ${doLess.max_turns}-turn cap.`;
  const fn =
    doLess === undefined ? "renderCodingAgentDriverScript" : "renderCodingAgentDoLessDriverScript";
  const tag = doLess === undefined ? "" : heredocTag(doLess.claude_md);
  const lines: string[] = [
    CLI_SCRIPT_SHEBANG,
    `# ${title}`,
    `# ${CODING_AGENT_GENERATED_MARKER} ${fn} (TDM-39): regenerate it, do not edit by hand.`,
    "#",
    "# Verbs: start | ready | stop are no-ops | run <task> <workspace>   (task = the workload's instruction.md)",
    "# run writes under EVAL_OUT:",
    `#   ${P.stream.padEnd(24)} Claude Code stream-json, secrets redacted (collector: stream-json)`,
    `#   ${P.versions.padEnd(24)} pinned and observed Claude Code / model / node versions`,
    `#   ${(P.workspace + "/").padEnd(24)} the workspace as the agent left it (the hidden-tests gate tests it)`,
    `#   ${P.exitCode.padEnd(24)} Claude Code's exit status; ${P.stderr} its stderr`,
    `#   ${P.error.padEnd(24)} why the driver refused the trial, when it did`,
    "# Env: CLAUDE_CODE_VERSION, CC_MODEL / ANYBENCH_MODEL (pins, when not baked in below),",
    "# CC_SETUP (a folder under adapters/ with CLAUDE.md and .claude/), CC_DISALLOWED_TOOLS,",
    "# CC_MAX_TURNS / ANYBENCH_MAX_TURNS and CC_TOKEN_CAP / ANYBENCH_TOKEN_CAP_TOKENS (can only lower",
    "# the caps; the token cap stops the run when the stream crosses it), CLAUDE_MD_OVERLAY (kit-relative,",
    "# appended to CLAUDE.md: the planted regression), ANYBENCH_EVAL_USER / ANYBENCH_EVAL_HOME.",
    `# ${TOKEN_SOURCE_ENV}: naive_proxy (default; the worker's proxy env file NAIVE_PROXY_ENV, default`,
    "# $HOME/.anybench/proxy.env) or anthropic_key (BYOK ANTHROPIC_API_KEY from the runner's env or",
    "# EVAL_SECRETS). Credentials reach the agent only as 0600 files, never on a command line.",
    "set -euo pipefail",
    "",
    `contender=${shQuote(t.contender_id)}`,
    `pinned_cc_version=${shQuote(t.claude_code_version ?? "")}`,
    `pinned_model=${shQuote(t.model ?? "")}`,
    `eval_user="\${ANYBENCH_EVAL_USER:-${t.eval_user}}"`,
    `setup_dir=${shQuote(t.setup_dir ?? "")}`,
    `base_disallowed=${shQuote(t.disallowed_tools.join(" "))}`,
    `base_max_turns=${shQuote(t.max_turns === undefined ? "" : String(t.max_turns))}`,
    `base_token_cap=${shQuote(t.token_cap_tokens === undefined ? "" : String(t.token_cap_tokens))}`,
    `secret_names=${shQuote(t.secrets.join(" "))}`,
    `do_less=${doLess === undefined ? 0 : 1}`,
    `do_less_max_turns=${shQuote(doLess === undefined ? "" : String(doLess.max_turns))}`,
    ...(doLess === undefined
      ? ["do_less_claude_md() { :; }"]
      : [
          "do_less_claude_md() {",
          `  cat << '${tag}'`,
          doLess.claude_md.replace(/\n+$/, ""),
          tag,
          "}",
        ]),
    "out=''",
    "",
    BASH_FAIL,
    BASH_PIN_PREDICATES,
    BASH_REDACT,
    BASH_CLAUDE_LAUNCHER,
    BASH_FREEZE_WORKSPACE,
    BASH_STREAM_INIT,
    BASH_KILL_EVAL,
    "",
    RUN,
    "",
    'case "${1:-}" in',
    "  start | ready | stop) exit 0 ;;",
    "  run)",
    "    shift",
    '    run_agent "$@"',
    "    ;;",
    "  *)",
    '    echo "usage: driver.sh start | ready | run <task> <workspace> | stop" >&2',
    "    exit 2",
    "    ;;",
    "esac",
    "",
  ];
  return lines.join("\n");
}

/** Render the honest `adapters/<id>/driver.sh` for a coding-agent contender. */
export function renderCodingAgentDriverScript(input: CodingAgentDriverTemplateInput): string {
  return render(CodingAgentDriverTemplateSchema.parse(input), undefined);
}

/**
 * Render the do-less overlay driver: the same driver with "skip the tests" appended to CLAUDE.md
 * and a 3-turn cap. Put it at `proof/do_less/<id>/driver.sh` and name it as the overlay's
 * `driver_patch`. It must fail the hidden-tests gate.
 */
export function renderCodingAgentDoLessDriverScript(
  input: CodingAgentDriverTemplateInput,
  doLess: CodingAgentDoLessInput = {},
): string {
  return render(
    CodingAgentDriverTemplateSchema.parse(input),
    CodingAgentDoLessSchema.parse(doLess),
  );
}
