# kits/harness-league

The harness and skills league for Anybench (plan.md E21). Question: **on a whole-application
build, do the popular Claude Code skill packs and harnesses make Claude Code better?** Everyone is
making skills; this kit measures whether they help, with the same correctness gate, caps and
statistics as every other Anybench kit.

The arena is E18's (`kits/tandem-long-horizon`): the multi-user project tracker API in two sizes,
`project-tracker` (12 feature areas, 120 hidden tests) and `project-tracker-xl` (33 areas, 600
hidden tests), under a 3 h cap and a $25 spend cap per trial, graded with partial credit. Read
that kit's README for the task, the hidden tests, the gate and the proof.

## Contenders

Chosen by evidence in TDM-227 [21.1]; the table, the sources and the install transcripts are in
`docs/findings/harness-league-contenders.md`.

| | Contender | What it is | Pin | Install |
| --- | --- | --- | --- | --- |
| A | `claude-code-solo` (baseline) | plain headless Claude Code; `Task`, `Agent`, `Workflow` disallowed | E18's A, under the headless policy | `adapters/claude-code/install.sh` |
| B | `claude-code-subagents` | Claude Code with its built-in subagent tool and three project agents (implementer, test-writer, reviewer) | the agents of `kits/tandem-vs-claude-code`, byte for byte | as A |
| G | `gstack` | garrytan/gstack, 63 skills (`/office-hours`, `/review`, `/qa`, `/ship`, ...) | v1.98.0.0 = `91009308` | its README: clone into `~/.claude/skills/gstack`, `./setup` |
| S | `superpowers` | obra/superpowers, 15 skills plus a SessionStart hook (brainstorming, plans, TDD, subagent-driven development, ...) | v7.0.2 = `22f0b463` | its README: a Claude Code plugin (`claude plugin install`) |
| D | `tandem` (`TANDEM_WORKERS=3`) | planner and 3 workers on a Tandem board | E18's D, unchanged | `adapters/tandem/install.sh` |

Every setup: `claude-opus-5-5` on Claude Code 2.1.319, our own Anthropic key
(`AB_TOKEN_SOURCE=anthropic_key`, default effort, thinking on), 3 h and $25 per trial, approvals
automatic. Disclosure: `tokens: anthropic-key, effort: default, thinking: on`.

Not in the league, with the reason (details in the findings): **ruflo (claude-flow)**, whose
`init` writes about 2 MB of config, its own `CLAUDE.md` and SQLite memory into the graded
workspace, whose MCP server runs `npx ruflo@latest` at trial time, and whose own output says its
plugins load nothing in a headless `claude -p`; **ECC (everything-claude-code)**, whose guided
setup installs the plugin from the default branch (its last release, v2.2.3, is five weeks behind
it), so the recommended install cannot be pinned.

## Fairness rules, as configured

- **One contender per tool, installed the way its own README says**, at an exact release commit.
  Every change from a plain install is listed here and in the findings:
  - gstack: `./setup` runs without a terminal, so it takes its documented non-interactive
    defaults (flat skill names, no plan-tune hooks, the default Stop hook). `update_check` is set
    to `false` (a documented `gstack-config` key) so no "upgrade available" prompt can move the
    pin mid-trial; `auto_upgrade` and telemetry are off by default. Its bundled Chromium needs
    system libraries the image lacks; gstack's own `bin/gstack-browser-ensure --with-deps`
    installs them.
  - superpowers: the README's marketplaces do not give an exact current release (the official
    marketplace pins v7.0.0, superpowers-marketplace follows the default branch), so the
    marketplace added is the repo's own manifest (`superpowers-dev`) at the v7.0.2 commit. Same
    plugin, same install mechanism.
- **Same instructions for every setup, except what a tool's docs prescribe.** Every Claude Code
  setup's `CLAUDE.md` has the three task-agnostic lines A has had since E18 (read first, follow
  the repo's patterns, write and run tests). B adds its subagent roster; G adds the `## gstack`
  section its README prescribes; S adds nothing (its README prescribes no text). No setup gets a
  task-specific prompt.
- **Tools.** A and D disallow the subagent tools (`Task`, `Agent`), as in E18. B, G and S keep them:
  B is about them, and both skill packs dispatch subagents in their own docs. Every setup
  disallows Claude Code 2.1.319's multi-agent `Workflow` tool: no contender's docs use it, and a
  setup that could fall back on it would measure `Workflow`, not the tool under test.
- **A skill pack never loads in another setup's trial.** One env snapshot serves the whole kit,
  so each skill pack's install runs its README's steps with `HOME=~/.anybench/homes/<tool>` (its
  `~/.claude/skills`, `~/.claude/plugins`, hooks and state live there), and
  `adapters/tool-home/driver.sh` points `HOME` there for that contender only, then runs the
  shared `adapters/claude-code/driver.sh`. Each health check fails if anything leaked into the
  eval user's real `~/.claude`. The docker-local run with every contender in one image shows
  A's session with 0 gstack or superpowers skills.
- **Interactive steps** (a skill asking the user a question) get one auto-answer policy for every
  Claude Code setup: the headless policy below (TDM-228). What each tool does is recorded in
  `docs/findings/headless-policy.md`.

## Headless policy (`headless-v1`)

In `claude -p` (Claude Code 2.1.319) there is no `AskUserQuestion` tool, not even behind
`ToolSearch`: a skill that wants to ask asks in plain text, and a plain-text question ends a `-p`
run with result `success` and the work undone. gstack renders a prose decision brief and stops;
Superpowers' skills say nothing is built until the design is approved and the user says "go" (in
three docker-local smokes it built through anyway, and asked once, after the work, whether to
commit: `docs/findings/headless-policy.md`). Scoring a stop as a
failure would measure our harness, not the tool, and a reply only one tool gets would be a
one-sided assist. So every Claude Code setup (A, B, G, S) runs under one policy:

> When a session's final message waits on the user (a question mark ending one of its last three
> lines, or a waiting phrase such as "reply with", "say go", "approve the design", "waiting for
> your", gstack's `BLOCKED — AskUserQuestion unavailable`), the same session is resumed
> (`claude -p <reply> --resume <session id>`, every other flag unchanged) with the reply
> **"Yes, approved. Proceed with your recommended option and complete the task."**, at most 8
> times per trial. Nothing is added to any prompt or `CLAUDE.md`.

- **Where:** `adapters/headless-policy/` (`policy.mjs` the detector, reply and cap; `shim.mjs`
  behind `bin/claude`, which `driver.sh` puts first on `PATH`, so E18's
  `adapters/claude-code/driver.sh` runs byte for byte with the policy around Claude Code). A and B
  use `adapters/headless-policy/driver.sh`; G and S use `adapters/tool-home/driver.sh`, which sets
  their home and then runs the same driver. The detector reads only the session's own final
  message: no contender id, workspace, gate or hidden test goes in.
- **Measured:** each firing is a `system/anybench_auto_answer` event in `stream.jsonl`; bench's
  stream-json collector reports `questions_auto_answered` (and `auto_answer_cap_reached`) per
  trial, 0 when the policy ran and never fired. A resumed session is billed once (its last
  result is the whole session's cost) and the runner's spend cap counts the resumed process.
- **Why no prompt line** ("you are unattended, don't ask"): it would change every setup's prompt,
  A's included, and override what the skill packs are for (Superpowers' design approval, gstack's
  decision briefs). The continuation answers only the setups that ask, the way a user who accepts
  every recommendation would, and leaves each tool's documented behaviour intact. gstack has its
  own unattended switch (`GSTACK_SESSION_KIND=unattended`); it is not set, because its README
  install does not set it and it changes which questions gstack asks.
- **A differs from E18's A by exactly one thing:** its driver is
  `adapters/headless-policy/driver.sh` instead of `adapters/claude-code/driver.sh` (the prompt,
  `CLAUDE.md`, tools, caps and settings are E18's). In a trial where A never stops to ask, the
  two run identically; where it does, A here gets the reply and E18's A ended there.
- **D (Tandem)** keeps E18's adapter byte for byte: its sessions are Tandem's planner and workers,
  and its human step is the board's approval gate, answered by `human_in_loop.policy: auto` (the
  same "approve" for every epic).
- **Report disclosure:** `tokens: anthropic-key, effort: default, thinking: on; headless policy
  headless-v1 for every Claude Code setup: a session that stops to ask is resumed with "Yes,
  approved. Proceed with your recommended option and complete the task." (at most 8 times per
  trial, counted as questions_auto_answered); Tandem's approvals automatic`
  (`HARNESS_LEAGUE_DISCLOSURE` in apps/server `proof-score.ts`), plus a per-setup line
  `questions auto-answered (headless policy): <setup> <n> in <trials> trials; ...`.

## Shared with E18, byte for byte

KitSpec cannot reference another kit's files (validateKitDir refuses any path that resolves
outside the kit), so `scripts/sync-shared.mjs` copies these from `kits/tandem-long-horizon`:
`workloads/`, `gates/`, `proof/`, `rubric.md`, `PROOF.md`, the scripts the gate and proof use,
and the adapters of A and D (`adapters/claude-code/`, `adapters/claude-code-solo/`,
`adapters/tandem/`), plus `adapters/claude-code-subagents/` from `kits/tandem-vs-claude-code`.
Everything in `anybench.yaml` from `workloads:` on is E18's text.

```sh
node kits/harness-league/scripts/sync-shared.mjs --check   # exit 1 on any difference
node kits/harness-league/scripts/sync-shared.mjs           # re-copy after an E18 change
```

Because the workloads, hidden tests, gate and oracle are identical, **E18's proof
(`PROOF.md`: oracle 120/120 and 600/600 three times each, do-nothing and the partial oracle
refused) is this kit's proof**; no new sign-off is needed while `--check` passes. A change to E18's
arena must be synced here (and the test fails until it is).

Reusing E18's Tandem results (epic E21): D's adapters, pins and settings are byte-identical, but
the kit is a different kit (its hash differs), so whether E18 run-1 trials can stand in for D here
is ticket 21.3's call.

## Running it

On the live app the league is a curated kit of the Tandem repo: a GitHub run on
`jaximus808/tandem` whose question says "harness league" (or "skills league"). The question also
picks the workload (`project-tracker` unless it names the xl rung) and the repeats ("n=5"). The
founder's run (v1, five setups, n = 5, a $150 hard stop on the Anthropic key), its estimate and
the exact commands: `docs/findings/harness-league-run-plan.md` (TDM-245).

## Checks

```sh
# validateKitDir, the comparability rules, the skeptic and the byte-identical arena:
pnpm --filter @anybench/kit exec vitest run test/tdm227-harness-league-kit.test.ts
# the headless policy through every Claude Code setup's real driver, on recorded Claude Code streams:
pnpm --filter @anybench/bench exec vitest run test/tdm228-headless-policy.test.ts
# every contender installed into one docker-local image as the env build does, the health
# checks, and a 1-turn "list your skills" smoke per Claude Code setup (about $0.25 of tokens):
node --env-file=.env --import tsx scripts/spikes/harness-league/healthcheck-docker-local.ts all \
  --smoke claude-code-solo,claude-code-subagents,gstack,superpowers
```

## Layout

```
anybench.yaml                       the kit: five setups; from `workloads:` on, E18's text
adapters/gstack/                    install.sh, healthcheck.sh, CLAUDE.md (shared lines + README section)
adapters/superpowers/               install.sh, healthcheck.sh, CLAUDE.md (shared lines only)
adapters/headless-policy/           driver.sh, bin/claude, shim.mjs, policy.mjs: the headless policy (A, B, G, S)
adapters/tool-home/driver.sh        HOME=~/.anybench/homes/<tool>, then adapters/headless-policy/driver.sh
adapters/claude-code*/, tandem/     copies (A, B, D)
workloads/, gates/, proof/, ...     copies of kits/tandem-long-horizon
scripts/sync-shared.mjs             makes and checks the copies
```
