# Understander: live eval on Naïve (TDM-56 [6.2], 2026-11-08)

## What exists

- Role `packages/agents/understander/{prompt.md, output.schema.json, config.json}`: model
  `deepseek/deepseek-v4-flash-0731` (harness `pi`, no tools), task cap 100,000 µ$.
- `@anybench/agents` `understander.ts`: `buildUnderstanderInput` (the digest plus the repo context:
  a line-numbered README cut at 16,000 chars, 40 dirs, 200 paths, 8 manifests of at most 2,500
  chars, test/bench paths, the test-commit count and 10 subjects), `UnderstanderOutputSchema`,
  `decideUnderstanding` (the verdict rules in code), `verifyClaims`, `UnderstandingExtrasShape`.
- Server: `orchestrator/repo-ingest-cache.ts` (`loadRepoIngest`, `writeRepoIngestCache`,
  `readRepoIngestCache`, `repoIngestCacheDir`: `~/.anybench/ingest/<digest hash>.json`, written by
  `githubIngest`, re-ingested at the digest's commit on a miss) and `orchestrator/kit-builder.ts`
  (`kitBuilderStages`, `naiveUnderstand`, `defaultAgentStages`, `UNDERSTANDER_BUDGET_MICRO_USD`).

## Verdict rules (code, after the model answers)

1. `driver_type: cli` with no executable evidence (a `bin`/`script` entrypoint, `src/main.rs`,
   `main.go`, `__main__.py`, `bin/*`, `"bin":`, `[project.scripts]`, `console_scripts`, `[[bin]]`)
   becomes `lib`.
2. `coding-agent` / `http-agent` force kind `agent`; `harness` forces kind `harness`.
3. `http-agent` counts as supported only when `labelled_conversations` is a path in the tree.
4. Nothing runnable (no entrypoint, manifest, build or test command, only document languages)
   becomes `skip` whatever the model said.
5. Claims are kept only when the quote is on the cited line (or the next two) of the README or a
   manifest we sent.
6. Order: skip → `fail "not benchable: …"`; needs_hardware → hold `"needs hardware: …"`; a driver
   other than cli, coding-agent, harness → hold `"driver <type> is not supported yet: <why>"`;
   else ready.

## Labels (written before any model run)

`packages/agents/understander/fixtures/expected.json`, from reading each repo:

| repo | kind | benchable | driver | outcome | why |
|---|---|---|---|---|---|
| agentcanvas | harness | ready | harness | ready | Tandem: a task queue for parallel Claude Code sessions |
| eyetrax | software | needs_hardware | lib | hold | Python webcam eye-tracking library; its CLIs are demos |
| obrist | agent | ready | http-agent | hold | FastAPI + LangGraph art-gallery chat agent, no labelled set |
| web-helper | software | ready | web | hold | browser extension + local bridge to `claude -p` |
| quant-grader | software | ready | web | hold | offline grader with a browser UI on a stdlib Python server |
| SHTRM | software | needs_hardware | service | hold | webcam hand tracking driving a physical robotic hand |
| PersonalWebsite | software | skip | web | fail | a personal Next.js site |
| ripgrep | software | ready | cli | ready | |
| fd | software | ready | cli | ready | |

**Where the repos came from.** `git ls-remote https://github.com/jaximus808/<name>` asked for
credentials for agentcanvas, eyetrax, obrist, web-helper and quant-grader (private or missing;
there is no `gh` CLI or `GITHUB_TOKEN` on this machine), so the eval ingests the local checkouts
under `~/coding-project/` with `ingestLocalRepo(dir, {githubUrl: "https://github.com/jaximus808/<name>"})`.
agentcanvas is the Tandem checkout (its origin is `jaximus808/tandem`); eyetrax's origin is
`ck-zhang/eyetrax`, obrist's is `Janayan002/obrist`. web-helper and quant-grader are plain
folders, not git repos: the eval snapshots each into a one-commit temp repo (no history).
ripgrep and fd are fetched from GitHub.

## Live run

```
cd apps/server && LOCAL_DATABASE_URL=postgres://anybench:anybench@localhost:55432/anybench \
  NAIVE_LIVE=1 TDM56_LIVE_OUT=<scratch>/tdm56-live.json \
  node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs \
  run test/understander-naive-live-tdm56.test.ts --reporter=verbose
```

Each repo runs through `naiveUnderstand` → `runAgentStage` (agent `anybench-understander`, created
by the first session's ensureAgent) → `decideUnderstanding`. Output:

```
MATCH agentcanvas      expected harness/ready/harness/ready got harness/ready/harness/ready 5565 µ$ "A single Go binary over SQLite with no GPU, display, camera or device needed; it builds and the Go and MCP-gateway test suites run unattended on a Linux VM, and"
MATCH eyetrax          expected software/needs_hardware/lib/hold got software/needs_hardware/lib/hold 1945 µ$ "needs hardware: Its central job — calibrating and estimating gaze — requires a webcam plus a display/GUI session to show calibration points; every CLI demo and " corrections: dropped 1 claim(s) whose quote is not on the cited line
MATCH obrist           expected agent/ready/http-agent/hold got agent/ready/http-agent/hold 2879 µ$ "driver http-agent is not supported yet: FastAPI server whose primary interface is POST /art-agent/prompt — a conversational LangGraph ReAct loop with MCP tools " corrections: dropped labelled_conversations "null" (not in the tree)
MISS  web-helper       expected software/ready/web/hold got software/skip/web/fail 1739 µ$ "not benchable: Glue code whose entire measurable output is produced by the external, paid Claude Code service; it cannot run unattended on a VM without a GUI br"
MATCH quant-grader     expected software/ready/web/hold got software/ready/web/hold 2456 µ$ "driver web is not supported yet: Documented usage is `python3 server.py` then editing in a browser at 127.0.0.1:8765 (Run/Submit hotkeys, autosave, part unlocki"
MATCH SHTRM            expected software/needs_hardware/service/hold got software/needs_hardware/service/hold 1857 µ$ "needs hardware: The subject's core function — webcam hand tracking driving a physical robot — demands a webcam, a servoed robotic hand, Arduino/ESP8266 hardware"
MATCH PersonalWebsite  expected software/skip/web/fail got software/skip/web/fail 2578 µ$ "not benchable: It is a personal portfolio/blog website with no runnable benchmarkable behavior; the only testable unit (tools/writer) is a local-only authoring "
fixture: 6/7 match, 19019 µ$
MATCH ripgrep          expected software/ready/cli/ready got software/ready/cli/ready 3907 µ$ "Builds to a single `rg` binary via cargo or a static prebuilt release download, runs headless on a plain Linux VM with no GPU or special devices, and has an ext"
MATCH fd               expected software/ready/cli/ready got software/ready/cli/ready 2152 µ$ "cargo build produces a standalone `fd` binary that runs unattended on a Linux VM against synthetic directory trees; no GPU, display or special devices needed."
live total: 25078 µ$ over 9 sessions
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

**Score: 6/7 on the fixture (kind + benchable), every driver type as labelled, and ripgrep and fd
both `cli / ready / supported`.** Verified claims kept: agentcanvas 3, ripgrep 4, fd 1,
quant-grader 1. One attempt per repo: no 429 "at capacity" this time (compare
agent-registry.md).

**Live spend: 25,078 µ$ (≈ $0.025) for 9 sessions**, 1,739–5,565 µ$ each (agentcanvas, the
biggest README and tree, cost the most). No pre-flight 402 at the 100,000 µ$ cap.

## Notes

- The one miss, web-helper: the model said `skip` ("its output is produced by the paid Claude
  Code service; a number would benchmark Anthropic's model, not this repo"). I labelled it
  `ready` + web (hold). Both stop the run before a kit; the model's reading is defensible.
- deepseek returned `"labelled_conversations": "null"` (the string) for obrist. Code now treats
  `"null"`, `"none"`, `"n/a"` and `""` as null (the correction line above is from before that fix).
- `subject_command` is a hint only: TDM-60 must resolve and pin the release asset + sha256 in
  code, never trust the model's install route blindly.
