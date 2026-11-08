# Brief: redesign the live run page

You are redesigning the page a user watches after they start a benchmark run: `/runs/[id]` on
https://anybench.vercel.app. Read `CLAUDE.md`, `docs/design/design-system.md`, and this file.

## What the founder wants

> "I don't need to see the future runs. I want full visibility of what's happening **now**: what's
> currently happening, with a cool effect and animation so it's actually exciting and hype. Once
> that phase is done, move to another phase."

> (about the current page) "Way too small; who is going to see this? I just see the 0/0 and assume
> it's broken."

What that means for the design:
- **One phase on screen at a time, full width, big.** Today's page shows every stage, a grid of
  counters at 0/0, an empty trial grid and a small activity log. All of that reads as "broken".
  Show the phase the run is in now as the hero. When it finishes, play a transition into the next
  phase. Finished phases collapse to a short "done" line, and future phases are hidden or barely
  hinted.
- **Something moving at all times.** Pulse, progress, streaming text, timers. A phase with nothing
  new to show still shows a live elapsed timer and what it is waiting on.
- **Real data only.** Never fake progress. Every animation has to be driven by a real event or a
  real clock.
- It has to work at 375px and respect `prefers-reduced-motion`.

## The phases (run states) and what to show in each

`intake → understand → research → kit_draft → env_build → proof → awaiting_go → running → scoring
→ analyzing → delivered`. A run can also be `needs_human` (paused, with `paused_reason`), `failed`
or `cancelled`.

| Phase | What is really happening | Events you get |
|---|---|---|
| understand / research / kit_draft | Agents read the repo, pick competitors and design the test. These take seconds for the Tandem repo, which uses a curated kit. | `agent.message` with `payload.agent_role` (understander, researcher, kit_designer) and `payload.text` |
| env_build (about 4–6 min) | A Naïve cloud computer boots, installs Claude Code 2.1.319 + Tandem 0.2.0, and is snapshotted. A second scoring image is built in parallel. | `agent.message` with role `env_builder` (added in 8e7c285): "trial image: booted a Naïve computer", "installed the base toolchain", "installed the Anybench runner", "installed tandem", "snapshot saved; every trial forks from it", "Naïve is at capacity; retrying", and the same lines prefixed "scoring image:" |
| proof | Checks the kit can tell right from wrong. Instant for the curated Tandem kit. | `agent.message` role `proof` |
| awaiting_go | Waiting for the user to press Go. Show the trial count, the setups, the tasks and the estimated cost. This is the big moment. | run detail (`GET /runs/:id`), estimate; Go is `POST /runs/:id/go` (component `GoBar.tsx`) |
| running (1–3 h) | 30–36 trials, 5 at a time, each on its own Naïve computer: Claude Code solo vs Tandem ×3 on 3 tasks (todo-api, auth-refactor, bug-hunt). | `trial.phase`, `trial.heartbeat`, `trial.log_chunk`, `trial.gate` (pass/fail), `computer.created/destroyed`, `usage.recorded` (spend) |
| scoring / analyzing | Grading and stats. Fast. | `run.state_changed`, `agent.message` |
| delivered | The verdict. The Results panel (TDM-103) reads `GET /runs/:id/report`. | report JSON (has `per_task` and `requirements[].by_task` since 3f30c72) |

For `running`, show only the trials that are live now (at most about 5). Show finished ones as a
compact tally (passed / failed / our failure) and queued ones as a single count. Each live trial
shows: setup name, task, a live timer, phase (booting → running → grading), and the latest log line
or token spend.

## Where the code is

- Page: `apps/web/app/runs/[id]/page.tsx` → `apps/web/components/live/LiveRunPage.tsx`
- Panels: `components/live/{ActivityFeed,AgentsPanel,TrialMatrix,GoBar,Drawers,SearchPalette}.tsx`,
  styles in `live.module.css`, formatting helpers in `format.ts`
- Data: `apps/web/lib/live/model.ts` is a pure reducer from events to a `LiveSnapshot`.
  `useLiveRun.ts` polls `GET /api/runs/:id/events` (poll mode, about 1 s). `client.ts` holds the
  calls.
- Event schema: `packages/core/src/schemas/event.ts` (`AnybenchEventSchema`)
- Results: `apps/web/components/report/` (TDM-103)
- Design system: `docs/design/design-system.md`, plus the landing page under
  `apps/web/components/marketing`

## How to iterate without a live run

- `apps/web/test/fixtures/simulator.ts` is a deterministic simulated run that emits schema-valid
  events for a whole run in about 2 minutes. It is test-only today. A good first step is a dev-only
  route (for example `/dev/live-sim`, excluded from production builds) that drives `LiveRunPage`
  from the simulator, so you can watch every phase in the browser with `pnpm --filter web dev`.
- `apps/web/test/fixtures/tdm75-run-stream.ts` and `tdm103-report.ts` are further fixtures.
- **Real data:** the founder's live run is `01a1b9d7-e637-7792-bf69-0fa614f9b86b`. Ask the
  orchestrator session to export its events as a JSON fixture; don't connect to the database
  yourself.

## Rules

- Work in a worktree (`git worktree add ../anybench-wt/live-redesign -b live-redesign`), and change
  only `apps/web`. Don't touch the server, the orchestrator or `packages/*`. If you need a new
  event, ask the orchestrator session.
- Keep the reducer pure and tested (`apps/web/test/live-model.test.ts`). Run
  `pnpm --filter web test`, the web typecheck, `pnpm lint` and `pnpm --filter web build`.
- No new runtime dependencies without a reason. CSS animations and Web Animations are fine.
- Don't deploy. The orchestrator session deploys the web with the Vercel CLI and promotes it to
  https://anybench.vercel.app. Merge to main (fast-forward) and say so.

## Prior work you can reuse

Branch `launch-ux-wip` (5b0289a), not merged: `components/live/LaunchDeck.tsx` + `launch.module.css` (agent cards from real events, a ticker, a Go panel, trial tiles), `lib/live/launch.ts` (mapping events to cards and tiles), 25 tests and a mock API server for screenshots. Take what is useful, ignore the rest. The Go bar that ships today is `components/live/GoBar.tsx` (added with Stripe onboarding, 2d2c36b).
