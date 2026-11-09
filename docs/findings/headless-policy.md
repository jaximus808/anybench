# Headless policy for interactive skills (TDM-228 [21.2], 2026-11-09)

What a Claude Code session does in `claude -p` when a skill wants to ask the user something, what
the harness league (`kits/harness-league`) now does about it, and the smokes that show it. The
policy itself is in the league README ("Headless policy") and
`kits/harness-league/adapters/headless-policy/policy.mjs`.

## AskUserQuestion in `claude -p` (Claude Code 2.1.319)

Probe, on the Mac with Claude Code 2.1.319, a scratch `HOME` (no skills, no CLAUDE.md), our
Anthropic key:

```sh
cd <scratch>/ws && HOME=<scratch>/home claude -p "Use the AskUserQuestion tool to ask me whether I prefer red or blue (two options, recommend blue). Then write my answer to color.txt." \
  --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-5-5 --max-turns 6 < /dev/null
```

What the stream showed:

```
system/init tools: Task Bash CronCreate CronDelete CronList DesignSync Edit EnterWorktree ExitWorktree ListAgents Monitor
                   NotebookEdit PushNotification Read ReportFindings ScheduleWakeup SendMessage Skill TaskStop ToolSearch
                   WebFetch WebSearch Workflow Write
tool_use  ToolSearch {"query":"AskUserQuestion","max_results":3}
tool_result "No matching deferred tools found"
assistant  I can't use the AskUserQuestion tool in this session. It isn't in my toolset, and searching the deferred
           tools found nothing. So I'll ask here instead: **Which color do you prefer?** 1. **Blue (recommended)** 2. Red
           Reply with your choice and I'll write it to `color.txt`.
result     subtype success, num_turns 2, total_cost_usd 0.0394, permission_denials []
```

So: **AskUserQuestion is not in the tool list and not deferred behind ToolSearch.** A call is not
an error and is not silently skipped; there is nothing to call. The model asks in plain text, and
that ends the `-p` run with `result: success`, the task undone (no `color.txt`).

Resuming the same session with a reply works headless and keeps the session id:

```sh
claude -p "Proceed with your recommended option. Complete the task." --resume 97aabc3c-5e00-4043-8e63-cf3459ec2dbc \
  --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-5-5 --max-turns 6 < /dev/null
```

```
system/init session_id 97aabc3c-5e00-4043-8e63-cf3459ec2dbc
tool_use Bash {"command":"echo \"blue\" > color.txt && cat color.txt"}
result   success, num_turns 2, total_cost_usd 0.0499, modelUsage inputTokens 10, cacheReadInputTokens 62819
```

**The resumed process's `result` is the whole session's bill, not its own:** `modelUsage` is the
sum of both processes (input 4 + 6 = 10, cache read 28394 + 34425 = 62819, cache creation 5747 +
251 = 5998) and `total_cost_usd` is $0.0499 for the session ($0.0394 + $0.0105). `num_turns` (2)
and `duration_ms` (4213 vs 5463) are the process's own. Consequences: bench's stream-json
collector now bills each session at its last result and adds turns and durations over processes
(this ticket); the runner's spend cap (`packages/runner` `TokenMeter`) already takes a session's
latest total instead of the sum (it would have counted $0.0893) and counts the turns after it
(TDM-239, e3e4b93); `packages/runner/test/tdm228-resumed-session.test.ts` replays the policy's
real driver output through it.

In `-p`, `CLAUDE_CODE_ENTRYPOINT` is `sdk-cli` and `CI` is unset (`echo "entry=$CLAUDE_CODE_ENTRYPOINT
ci=${CI:-unset}"` through the Bash tool printed `entry=sdk-cli ci=unset`).

## What each tool does with that (pinned sources)

- **gstack v1.98.0.0** (`910093087`): every skill's preamble echoes `SESSION_KIND` from
  `bin/gstack-session-kind`, which returns `interactive` unless `GSTACK_SESSION_KIND`
  (`spawned|unattended`), `OPENCLAW_SESSION`, `GSTACK_HEADLESS` or `CI` say otherwise. In our
  `-p` trial none is set and the entrypoint is `sdk-cli`, so gstack takes the **prose fallback**
  ("render the decision brief as a markdown message ... then send the complete brief as the turn's
  final message and STOP and wait for the typed answer"): a `D<N>` brief with a reply line, the
  recommendation and a closing `Net:` line, then the run ends. With `GSTACK_HEADLESS` or `CI` it
  would print `BLOCKED — AskUserQuestion unavailable` and stop. `GSTACK_SESSION_KIND=unattended`
  (docs/unattended.md) auto-decides recommended options but writes approval gates as pending and
  never approves them; it is gstack's own switch for a parent-driven run, not part of its README
  install, so the league does not set it (it would change which questions gstack asks).
- **Superpowers v7.0.2** (`22f0b463`): no AskUserQuestion. `brainstorming` has a hard gate
  ("Nothing gets built until your human partner approves the design doc"), `writing-plans` ends
  "Please review the plan. Which execution approach would you prefer? ... Does the plan capture
  what you want, and which approach should we use?", and the README says the build starts "once
  you say 'go'". In `-p` each of those is a plain-text question that ends the run.
- **A, B**: no skill asks; plain Claude Code may still end with a question.

## The policy (headless-v1)

One mechanism for every Claude Code setup (A, B, G, S), nothing added to any prompt:
`adapters/headless-policy/driver.sh` puts `bin/claude` (`shim.mjs`) first on `PATH` and runs
E18's `adapters/claude-code/driver.sh` unchanged. The shim runs the real Claude Code, streams its
output through, and when the process exits with `result: success` and a final message that waits
on the user (`awaitingUser` in `policy.mjs`: a `?` ending one of the last three non-empty lines,
or a waiting phrase in the last 1500 characters), resumes the same session with
`-p "Yes, approved. Proceed with your recommended option and complete the task." --resume <id>`
and the same flags, at most 8 times per trial. It writes `system/anybench_headless_policy` once,
`system/anybench_auto_answer` per firing and `system/anybench_auto_answer_cap` at the cap into
`stream.jsonl`; bench's stream-json collector turns them into `questions_auto_answered` and
`auto_answer_cap_reached`. A signal (the driver's wall-clock `timeout`) stops the policy.

Why this and not a prompt line ("you are running unattended, make assumptions, don't ask"): the
line would change A's prompt (A would no longer be E18's A in its prompt) and every skill pack's
documented flow (Superpowers' design approval, gstack's decision briefs are what those tools are
for). The continuation changes nothing for a setup that never asks, and for one that asks it gives
the answer a user who accepts every recommendation would type. Equal for all: the detector takes
only the session's own final message; no contender id, workspace, gate or test.

The detector also fires on a question asked after the work is done ("Should I commit this on a
branch?", smoke 2 below). That costs one resumed turn and counts in `questions_auto_answered`; it
applies to every setup the same way, so it is disclosed, not special-cased.

What changed in the kit: A and B's `driver.script` is `adapters/headless-policy/driver.sh`;
`adapters/tool-home/driver.sh` (G, S) execs it instead of `adapters/claude-code/driver.sh`. The
E18 copies (`adapters/claude-code/`, `adapters/claude-code-solo/`, `adapters/tandem/`) stay byte
for byte (`scripts/sync-shared.mjs --check` passes), and `kits/tandem-long-horizon` is not
touched. So **A differs from E18's A by exactly its driver script**; D is E18's D.

## Docker-local smokes (setup S, one container, 2 CPUs)

```sh
pnpm -r build
# 1. the todo-api task of kits/tandem-vs-claude-code (a full contract)
node --env-file=.env --import tsx scripts/spikes/harness-league/healthcheck-docker-local.ts superpowers --smoke \
  --task kits/tandem-vs-claude-code/workloads/todo-api/instruction.md --input kits/tandem-vs-claude-code/workloads/todo-api/input
# 2. a loosely specified task on a near-empty repo (package.json + README)
#    task: "Build a small command-line reading-list tracker in this repository: I want to add books,
#           mark them as read, and list them. Node 22, no dependencies."
node --env-file=.env --import tsx scripts/spikes/harness-league/healthcheck-docker-local.ts superpowers --smoke \
  --task <scratch>/rl-task.md --input <scratch>/rl-input --wall 900
```

Both ran through `adapters/tool-home/driver.sh` with the kit's S env, no turn limit, on our key,
with E18's driver as of c6c9a72 (task as the `-p` argument). After rebasing on TDM-239 (the
driver now gives the task on stdin, `claude -p ... < task`; the wrapper hands its stdin to the
first process and resumes with the reply on argv and no stdin), smoke 2 was run again (smoke 3).

| | 1. todo-api | 2. reading-list | 3. reading-list, stdin driver |
| --- | --- | --- | --- |
| install + health check | exit 0 (4 s): `superpowers 7.0.2 enabled` | same | same |
| driver exit | 0 in 243 s | 0 in 70 s | 0 in 59 s |
| hooks | `SessionStart:startup` | `SessionStart:startup` | `SessionStart:startup` |
| skills invoked | none | `superpowers:test-driven-development` | none |
| `claude` processes | 1 | 2 | 1 |
| `questions_auto_answered` | **0** | **1** (reason `question`) | **0** |
| what it asked | nothing | after building and testing: "Should I commit this on a branch?" | nothing ("I haven't committed anything.") |
| after the reply | | committed on `feature/reading-list-cli`, did not push or merge | |
| turns, tool calls | 16, 15 | 8 + 3, 8 | 6, 5 |
| cost (session's last result) | $0.7853 | $0.2329 → $0.2892 | $0.2188 |
| workspace | `src/{app,http,main,passwords,router,store}.ts`, 4 test files | `bin/reading-list.js`, `src/{reading-list,store}.js`, 2 test files | `bin/reading-list.js`, `src/{books,store}.js`, 2 test files |
| `npm test` in the frozen workspace | 19 pass, 0 fail | 13 pass, 0 fail | 12 pass, 0 fail |
| key leaks | 0 | 0 | 0 |

In all three runs Superpowers 7.0.2 on claude-opus-5-5 **built through without stopping for a design
approval or a "go"**: the plugin's SessionStart hook ran, but the model did not start
`brainstorming` (on two of the three runs it invoked no skill at all). The one question came after the work was
done, the policy answered it, and the count is in the trial metrics. Whether S stops on the 3 h
whole-app task is for the league's own trials to show; the policy is the same either way.

The S session of smoke 2 is a test fixture (`packages/bench/test/fixtures/tdm228/sp7.0.2-reading-
list-{1,2}.jsonl`); replayed through A's, B's, G's and S's real drivers it fires once, with the
same events, in each (`packages/bench/test/tdm228-headless-policy.test.ts`).

Token spend for this ticket: AskUserQuestion probe and resume $0.0499, entrypoint probe $0.0372,
smoke 1 $0.7853, smoke 2 $0.2892, smoke 3 $0.2188: **$1.38**.

## TDM-249: why run 1's trials ran without the policy

Run 1 (TDM-229, `docs/findings/harness-league-run-1.md`) had no `system/anybench_headless_policy`
in any stream. Cause, confirmed from the code: git has `adapters/headless-policy/bin/claude` as
`100755`, every provider's `putFile` (Naïve, docker, fake) applies the mode it is given, the kit
tarball unpack and the worker bundle keep `x` bits, but apps/server `subjectPlan` staged every
kit file `f.path.endsWith(".sh") ? 0o755 : 0o644`. So `bin/claude` landed 0644. The docker-local
smokes above did not catch it: `healthcheck-docker-local.ts` stages the kit with `tar`, which
keeps the mode.

What bash does with a 0644 file first on PATH (run here on macOS bash 3.2.57):

```sh
# a/claude is 0644 ("wrapper"), b/claude is 0755 ("real")
PATH="$PWD/a:$PWD/b:/usr/bin:/bin" bash -c 'command -v claude; claude'
# → .../b/claude
# → real
PATH="$PWD/a:/usr/bin:/bin" bash -c 'command -v claude; claude; echo "exit $?"'
# → .../a/claude
# → bash: .../a/claude: Permission denied
# → exit 126
```

With the real Claude Code further down PATH (a trial computer), bash skips the wrapper and runs
the real one: no policy, no error. Fixed: `subjectPlan` stages each file 0755 when it has any `x`
bit in the kit (or is a `.sh`), the image's cache key covers the staged modes (a mode change
builds a new snapshot; images built before the fix are not reused), and `driver.sh` exits 2 when
`bin/claude` is not executable or `command -v claude` is not it. The report states headless-v1
only for setups whose trial streams carry the start event (`harnessLeagueDisclosure`); the shim
writes that event before the first `claude` process, so "ran, 0 answers" and "did not run" differ.
Test: `apps/server/test/headless-policy-staging-tdm249.test.ts` (stages the league through
`subjectPlan` and `buildEnvSnapshot` on FakeProvider, forks, lays the files out with their modes
and runs A's driver with the recorded never-asking session).
