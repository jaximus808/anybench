---
title: Why we built Anybench
description: Most agents are tested by feel. We wanted a measurement instead, so we built one and pointed it at our own harness first. It lost.
date: 2026-11-08
draft: true
---

<!-- Number sources: every number in this post carries a `source:` comment naming the file it
comes from, relative to the Anybench repo root. -->

Most agents are tested by feel. You change a prompt or a tool, run a few tasks, read the output, and decide it seems better. We did it too. It is fast, and it is mostly noise.

Feel can't tell you if a change made the agent better or just different. It can't tell you what the change cost. And it is easy to fool, because you know which version you're looking at and you want the new one to win.

So we built Anybench. You point it at a project and ask one question: is it actually better? It answers with a measurement, not an impression.

## We tested our own harness first, and it lost

The first thing we measured was Tandem, our own harness for running several Claude Code sessions off one task queue. We built it, so we wanted it to win. We ran it against plain Claude Code on three coding tasks, with the same model, Claude Opus 5.5, and 18 trials per setup.<!-- source: README.md; docs/findings/trial-traces.md -->

|                         | Claude Code solo                                                | Tandem ×3<!-- source: README.md -->                             |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Passed the hidden tests | 94% (17/18)<!-- source: README.md -->                           | 89% (16/18)<!-- source: README.md -->                           |
| Average cost per trial  | $0.31<!-- source: README.md -->                                 | $2.32<!-- source: README.md -->                                 |
| Average time per trial  | 1m 11s<!-- source: README.md; docs/findings/trial-traces.md --> | 3m 57s<!-- source: README.md; docs/findings/trial-traces.md --> |

That is run 01a1bae4, and the [signed report](/r/nx7pu8ghukog0aizc1uk) is public.<!-- source: docs/findings/trial-traces.md; README.md -->

A number alone doesn't tell you what to fix, so every trial also keeps a trace: each session, model turn, tool call and board event on one timeline. The traces showed that 68% of Tandem's model time went to turns that only talked to the task board.<!-- source: docs/findings/trial-traces.md --> The workers spent more time coordinating than writing code.

They also showed why one Tandem trial failed. The planner asked for debounced writes to the data file. A worker wrote them, delaying each write by 50 ms.<!-- source: docs/findings/trial-traces.md --> The hidden test reads the file right after a user registers, before the write lands, so the file isn't there yet. That is a real bug, and it's the kind you don't catch by reading the output.

One caveat goes with this run. The tokens went through Naïve's model proxy, which runs the model at its lowest effort with thinking off (`tokens: naive-proxy, effort: naive-min, thinking: off`). Every setup had the same handicap, so the comparison is fair, but it isn't Claude Code at its defaults. <!-- source: kits/tandem-vs-claude-code/README.md -->

## What Anybench does

You give Anybench a GitHub repo (an agent, an MCP server, a skill or a harness) and one question. A fleet of agents does the rest:

1. It works out what the project does and what "better" should mean for it.
2. It researches what to compare it against: the obvious baselines and rivals.
3. It designs an eval kit: tasks, hidden tests the agent never sees, and the metrics that matter, like success, time and cost.
4. It proves the kit is fair before spending anything.
5. It runs every setup on its own cloud computer, enough times to tell signal from noise.
6. It grades each attempt on a separate scoring computer, then reports with real statistics.
7. It emails you the result and a signed page you can share.

## Honest by construction

A benchmark is only worth something if it can't flatter you. So the rules are in the code, not in a style guide.

- **No speed or cost number without a correctness gate.** Only attempts that pass the hidden tests count. A fast wrong answer is not a result.
- **No winner the statistics don't support.** Differences are tested with a Holm correction, and "not significant" is a valid answer.
- **Proof before trials.** Every kit has to pass its reference solution and fail a contender that does nothing. On the Tandem kit, the reference solution passed 42/42 hidden tests and the do-nothing contender passed 0/42.<!-- source: kits/tandem-vs-claude-code/PROOF.md; kits/tandem-vs-claude-code/README.md -->
- **Every trial has a trace,** and every failure says why it failed.
- **Results are signed.** A published report is frozen and signed with Ed25519, with a public page to verify it.<!-- source: README.md -->
- **You never pay for our failures.** Infrastructure failures are retried and never billed.

## The whole-app test

:::placeholder
This section is waiting on the long-horizon run: Tandem against plain Claude Code on a whole-application build, the kind of job that outgrows one session's context. It gets filled in with the result, win or lose. Until then, this post stays a draft.
:::

## Try it on your project

If you build an agent or a harness, you probably have a change you think is better. Point Anybench at the repo and find out. You can [sign up here](/signup).
