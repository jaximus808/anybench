# Harness league contenders (TDM-227 [21.1], 2026-11-09)

How the E21 league (`kits/harness-league`) got its contenders, how each is pinned and installed,
and what a docker-local install, health check and 1-turn smoke showed. Sources were read on
2026-11-09 through the GitHub REST API (`curl https://api.github.com/repos/<repo>`,
`.../releases?per_page=5`, `.../tags?per_page=5`), the npm registry, and the repositories at the
pinned commits. Star counts are that day's.

## Decision

| Setup | Tool | Why |
| --- | --- | --- |
| A | Claude Code solo | E18's baseline, unchanged |
| B | Claude Code + built-in subagents | the setup E18 dropped (founder's ask) |
| G | **gstack** v1.98.0.0 | the founder's ask, by name |
| S | **Superpowers** v7.0.2 | the most-starred Claude Code skill pack, active releases, installs headless |
| D | Tandem ×3 | E18's subject, unchanged |

Considered and left out: **ruflo** (formerly claude-flow) and **ECC** (everything-claude-code),
for the reasons below. One skill pack beyond gstack keeps the league at five setups; 21.3 sizes
the budget, and every setup costs at least 5 trials (TDM-210).

## Evidence

| | gstack | Superpowers | ruflo (claude-flow) | ECC |
| --- | --- | --- | --- | --- |
| Repo | [garrytan/gstack](https://github.com/garrytan/gstack) | [obra/superpowers](https://github.com/obra/superpowers) | [ruvnet/ruflo](https://github.com/ruvnet/ruflo) (`ruvnet/claude-flow` redirects here) | [affaan-m/ECC](https://github.com/affaan-m/ECC) |
| What | 63 skills (`/office-hours`, `/review`, `/qa`, `/ship`, ...) + browser tooling | 15 skills + a SessionStart hook: brainstorm, plan, TDD, subagent-driven development | multi-agent swarm harness: hooks, MCP server (406 tools), memory | 293 skills, 68 agents, hooks, rules |
| License | MIT | MIT | MIT | MIT |
| Stars | 140,884 | 314,842 | 81,323 | 299,942 |
| Last push | 2026-11-09 | 2026-11-03 | 2026-11-09 | 2026-11-09 |
| Latest release | v1.98.0.0, 2026-11-08 | v7.0.2, 2026-11-03 | v3.74.1, 2026-11-09 (npm `ruflo` latest 3.74.1) | v2.2.3, 2026-10-01 |
| Release cadence | v1.96 → v1.98 in 4 days | v7.0.0 10-10, v7.0.1 10-21, v7.0.2 11-03 | 5 releases 11-05 → 11-09 | last release 5 weeks old, main moving |
| Pin | tag v1.98.0.0 = `910093087dec4877f99dfaed6600784942ed7a7b` | tag v7.0.2 = `22f0b463e7a5e579904dd6211a520321035526f7` | (not pinned) | tag v2.2.3 = `c05b2d6614f62f6db0047669aa4eefb223d478f9` |
| Documented install | `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`, plus a "gstack" CLAUDE.md section | `/plugin install superpowers@claude-plugins-official` or `superpowers@superpowers-marketplace` | `npx ruflo@latest init` in the project | `npx ecc-universal@2.2.3 setup` (guided), or `/plugin marketplace add https://github.com/affaan-m/ECC` + `/plugin install ecc@ecc`, plus rule packs copied by hand |
| Headless (`claude -p`) | yes: skills are plain Claude Code skills, and gstack's own E2E tier spawns `claude -p` per skill (ARCHITECTURE.md "E2E via `claude -p`"); `./setup` has documented non-TTY defaults | yes: a plugin; the SessionStart hook fires in `-p` (smoke below); `claude plugin install` is non-interactive | **no**: its own `init` prints "a headless claude -p on a fresh config loads nothing" for its plugins | yes for the native plugin route; the guided setup has `--yes` |
| Verdict | **in** (founder's ask) | **in** | out | out |

### Why ruflo is out

Probe (docker, `node:22`, 2 CPUs):

```sh
docker run --rm --cpus 2 node:22 bash -c 'npm install -g ruflo@3.74.1 && mkdir /tmp/p && cd /tmp/p && git init -q && ruflo init </dev/null'
```

What it printed and wrote, in short:

```
[OK] ruflo mods enabled in /tmp/p/.claude/settings.json ...
Each teammate's first trusted interactive Claude Code start clones github.com/ruvnet/ruflo; a headless claude -p on a fresh config loads nothing.
[WARN] No runnable claude binary on PATH: the plugins are enabled in settings, not installed.
```

and `.claude/` (2.1 MB of helpers and hooks), `.claude-flow/`, `.swarm/agentdb-memory.db`,
`.agents/skills/ruflo/`, a `CLAUDE.md` and a `.mcp.json` whose server is
`npx -y ruflo@latest mcp start`, all inside the project. In the league that project is the graded
workspace: the tool would overwrite the setup's CLAUDE.md, put databases into what the gate and the
quality review read, fetch `ruflo@latest` at trial time (not the pin), and, by its own message, not
load its plugins headless. Running it would mean patching its config, which is not "configured per
its docs". Revisit if its maintainers document a headless, pinned setup.

### Why ECC is out

Its recommended install is the guided `npx ecc-universal@2.2.3 setup`; with
`--mode claude-plugin --scope user --hooks standard --yes` it runs without prompts, but
`scripts/lib/claude-plugin-setup.js` (v2.2.3, lines 22-24 and 516-523) runs
`claude plugin marketplace add https://github.com/affaan-m/ECC`, the default branch, so the plugin
installed is whatever main is that day, not v2.2.3 (released 2026-10-01; main was pushed
2026-11-09). Pinning it means bypassing the recommended path, and its README also asks the user to
pick rule packs by hand. Superpowers covers the same claim (a methodology skill pack, with
subagents) with a current, pinnable release. ECC is the next candidate if the budget allows a
sixth setup.

### gstack: the founder's copy vs the pin

The founder runs gstack 1.60.1.0 (commit `050abc7`) locally. The league pins the latest GitHub
release, v1.98.0.0, installed from GitHub, never from that copy.

## How each tool is installed

One env snapshot serves every contender of a kit (apps/server `subjectPlan`, packages/envs
`build.ts`: every contender's `install.sh` runs as root with `HOME` kept, then its health check as
the eval user). A skill pack installed into the eval user's real `~/.claude` would therefore load
in every setup's trial. So each skill pack's `install.sh` runs its README's steps with
`HOME=~/.anybench/homes/<tool>`, and `adapters/tool-home/driver.sh` sets `HOME` to that directory
for that contender only before running the shared `adapters/claude-code/driver.sh`. Each health
check fails if anything leaked into the real home.

- **gstack** (`adapters/gstack/install.sh`): `npm install -g bun@1.4.2` (README: "Bun v1.4.2+ (the
  tested version)"; `bin/gstack-bun-version.sh` `GSTACK_BUN_TESTED="1.4.2"`); the pinned commit
  fetched at depth 1 onto a branch `main` with `origin/main` at the same commit (what the README's
  depth-1 clone gave on release day) at `~/.claude/skills/gstack`; `./setup < /dev/null`.
  Without a terminal, setup takes its documented defaults: flat skill names, plan-tune hooks not
  installed ("non-interactive setup"), the default timeline Stop hook registered, update channel
  `stable`, telemetry off, `skill_routing`/`skill_contracts` off (`lib/skill-route.ts`
  `SWITCH_DEFAULT`), `proactive: core`. Two additions: `gstack-config set update_check false`
  (documented key, "suppress version check notifications"), so no upgrade prompt can move the pin
  mid-trial; and `bin/gstack-browser-ensure --with-deps`, gstack's own helper, because `./setup`
  downloaded Chromium but it could not start on a bare `node:22`
  (`chrome-headless-shell: error while loading shared libraries: libnspr4.so`); after it, the
  probe prints `BROWSER_OK node 158.0.8127.18`. CLAUDE.md: the README's section
  (`## gstack` / "Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__*
  tools.").
- **Superpowers** (`adapters/superpowers/install.sh`): `claude plugin marketplace add <repo at
  v7.0.2>` then `claude plugin install superpowers@superpowers-dev --scope user`. The README's
  marketplaces do not pin the current release: `anthropics/claude-plugins-official` pins
  superpowers at `bb92a777` (v7.0.0), and `obra/superpowers-marketplace` names only
  `https://github.com/obra/superpowers.git` (the default branch). The repo's own
  `.claude-plugin/marketplace.json` (`superpowers-dev`, `source: ./`) at the v7.0.2 commit gives
  the same plugin by the same mechanism at exact bytes. `claude plugin list` after install:
  `superpowers@superpowers-dev Version: 7.0.2 ... Scope: user Status: ✔ enabled`. CLAUDE.md: the
  README prescribes none.
- **B** uses E18's Claude Code install and driver; its `CLAUDE.md` and `.claude/agents/`
  (implementer, test-writer, reviewer) are `kits/tandem-vs-claude-code`'s, byte for byte.

### Instructions: one finding from the skeptic

The first league draft gave G only the README's gstack section and S an empty CLAUDE.md. The kit
skeptic blocked it: `one_sided_assist: coding-agent contender 'claude-code-solo' gets
adapters/claude-code-solo/CLAUDE.md but 'gstack', 'superpowers' get no instruction file`. It was
right: A's CLAUDE.md carries three task-agnostic lines (read first, follow the repo's patterns,
write and run tests) that a skill-pack setup would not get, so the comparison would have measured
those lines as well as the tool. Every Claude Code setup now has those three lines; G adds the
README's section, S adds nothing, B keeps its roster. The skeptic now has no blocking finding (the
warnings are E18's: contract instruction, the fixture copy, 2 tasks, 5 repeats, reviewed weight).
If the founder prefers "tool docs only, nothing shared", A's CLAUDE.md has to lose the lines too,
which breaks byte-identity with E18's A.

## Docker-local install, health checks and smokes

Every contender installed into one `node:22` container (2 CPUs) the way the env build does, health
checks after each install, then a `docker commit` and one 1-turn smoke per Claude Code setup, each
in a fresh container from that image (as each trial forks from the snapshot), through the setup's
real driver and kit env, on our Anthropic key:

```sh
pnpm -r build
node --env-file=.env --import tsx scripts/spikes/harness-league/healthcheck-docker-local.ts all \
  --smoke claude-code-solo,claude-code-subagents,gstack,superpowers
```

Task: "List the skills, plugins and slash commands you have available in this session, one per
line with a few words each. Do not read, create or change any file." with `CC_MAX_TURNS=1`.

```
13:13:25 install claude-code-solo exited 0 in 3s;  healthcheck exited 0
13:14:06 install gstack exited 0 in 41s;           healthcheck exited 0: BROWSER_OK node 158.0.8127.18
         gstack 1.98.0.0 at 910093087dec4877f99dfaed6600784942ed7a7b; 63 skill entries; bun 1.4.2
13:14:11 install superpowers exited 0 in 5s;       healthcheck exited 0: superpowers 7.0.2 enabled at
         /home/evaluser/.anybench/homes/superpowers/.claude/plugins/cache/superpowers-dev/superpowers/7.0.2
13:14:19 install tandem exited 0 in 7s;            healthcheck exited 0
13:15:43 smoke claude-code-solo exited 0 in 11s; key leaks 0
13:15:55 smoke claude-code-subagents exited 0 in 10s; key leaks 0
13:16:16 smoke gstack exited 0 in 17s; key leaks 0
13:16:36 smoke superpowers exited 0 in 14s; key leaks 0
```

(B shares A's install and health check, so the env build and this script run them once.)

What each session's `system/init` event reported (every one: `model claude-opus-5-5`,
`claude_code_version 2.1.319`, `apiKeySource ANTHROPIC_API_KEY`, result `success`, 1 turn):

| Setup | Skills | Plugins | Agents | `Task` tool | `Workflow` | Hooks fired | Real `~/.claude` touched | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 18 built-in, 0 gstack, 0 superpowers | none | built-ins only | no (disallowed) | no | none | yes (A's own CLAUDE.md) | $0.0310 |
| B | 18 built-in | none | + `implementer`, `reviewer`, `test-writer` | yes | no | none | yes (B's CLAUDE.md, agents) | $0.0363 |
| G | 80: 63 gstack (`gstack`, `office-hours`, `review`, `qa`, `ship`, `autoplan`, `browse`, ...) + built-ins | none | built-ins | yes | no | none at start | **no** (0 entries) | $0.0603 |
| S | 33: 15 `superpowers:*` + built-ins | `superpowers@superpowers-dev` 7.0.2 | built-ins | yes | no | `SessionStart:startup` | **no** (0 entries) | $0.0515 |

The answers matched: G listed the gstack skills by name, S "**Superpowers plugin skills** -
superpowers:brainstorming ... superpowers:writing-skills", A only Claude Code's built-ins. A's
session in the same image as gstack and Superpowers saw none of their skills: the separate homes
work. Tandem's health check passed; its adapters are E18's byte for byte, and a Tandem session is
a planner plus workers on a board, not a 1-turn call, so it gets no league smoke.

Token spend for the smokes, all runs of this ticket: $0.248 (each tool on its own image) +
$0.236 (all in one image, first CLAUDE.md) + $0.179 (all in one image, final kit) = **$0.66**.

## For 21.2 (headless policy)

What each tool does that needs a person, as seen in its pinned source and the smokes:

- **Claude Code 2.1.319 in `-p`**: `AskUserQuestion` is not in the session's tool list (none of
  the four smokes had it), so a skill that calls it cannot; the model has to ask in plain text,
  which ends a `-p` run. Check whether it is deferred behind `ToolSearch` before designing the
  auto-answer.
- **gstack**: 59 of its `SKILL.md` files tell the model to use `AskUserQuestion` (decision points,
  plan reviews, `/office-hours` forcing questions, `/ship` confirmations); its skills are slash
  commands, and `proactive: core` (default) lets the model auto-invoke `/office-hours`,
  `/review`, `/qa` and `/ship`. `/plan-tune` exists to tune how often it asks. Its Stop hook
  (timeline) is registered by default; `skill_contracts` (a Stop hook that blocks stopping) is
  off by default.
- **Superpowers**: no slash commands needed; skills are model-invoked, primed by the SessionStart
  hook. `brainstorming` asks "one open question" in plain text when the request is unclear and
  says to just do a "quick, clear task"; the README's flow waits for the user to sign off the
  design and say "go" before subagent-driven development. No `AskUserQuestion` call in its
  skills.
- **B and A**: no interactive step.

## Commands for the record

```sh
curl -sS https://api.github.com/repos/garrytan/gstack | jq '{stargazers_count, license: .license.spdx_id, pushed_at}'
curl -sS 'https://api.github.com/repos/garrytan/gstack/releases?per_page=5' | jq '.[] | {tag_name, published_at}'
curl -sS 'https://api.github.com/repos/obra/superpowers/tags?per_page=5' | jq '.[] | {name, sha: .commit.sha}'
curl -sSL https://api.github.com/repos/ruvnet/claude-flow     # 301 -> ruvnet/ruflo
curl -sSL https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json \
  | jq '.plugins[] | select(.name == "superpowers")'           # source.sha bb92a777 (v7.0.0)
curl -sSL https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json \
  | jq '.plugins[] | select(.name == "superpowers")'           # url only, version 7.0.2
```
