---
title: What is Tandem
description: Tandem is one task queue for the Claude Code sessions you already run in parallel. Here is how it works, why its claims are safe, and what our first benchmark of it found.
date: 2026-11-08
draft: true
---

<!-- Number sources: every number in this post carries a `source:` comment naming the file it
comes from. `tandem:README.md` is the Tandem repo's README (github.com/jaximus808/tandem; locally
../agentcanvas/README.md). Repo paths are relative to the Anybench repo root. -->

If you run more than one Claude Code session on a repo, the sessions need a way to split the work. Most people use a TODO.md. Several sessions edit it at once, or each worktree has its own copy. A file can't say who holds a task, and it can't stop two sessions from taking the same one.

Tandem is what we built for that. It is one task queue for the Claude Code sessions you already run in parallel: terminals, worktrees, subagents. They claim work from the same queue, read the same briefing, and only pick up work you approved.

## How it works

The loop is short.

1. An agent session plans the work and proposes it as an epic with tasks.
2. You approve the plan once, on the board in your browser.
3. Any number of sessions pull the approved queue. Each one claims a task, reports progress as it goes, and completes it with a commit link.

The board updates live while that happens. Agents can propose and claim. Only you can approve, reject or delete.

The plan stays in git. The churn (who claimed what, what state it's in, what it produced) moves into the queue, where every session on the machine reads it live.

## Claims are atomic

The part that has to be right is the claim. In Tandem a claim is one conditional `UPDATE … WHERE state = 'approved'` inside a serialized transaction. When two sessions go for the same task, exactly one wins. The other gets `{ claimed: false, claimedBy }`, which names the holder, and moves on to the next task.

Two tests hold that line:

- `TestClaimRaceHasOneWinner` races 8 goroutines on one real SQLite row. Exactly 1 wins and 7 lose, and every loser is told who holds the task.<!-- source: tandem:README.md -->
- `TestConcurrentWorkerClaimsProduceOneWinner` sends two concurrent claims for the same task through the HTTP handler. One gets a `200`, the other a `409`, and the `409` names the winner.<!-- source: tandem:README.md -->

## Local, with no account

Tandem is one Go binary and one SQLite file in `~/.tandem`, with a board in your browser. There is no account, no server to rent, and nothing phones home. Any MCP client works: Claude Code, Codex, Cursor or your own script.

Setup is one line:

```bash
npx -y @jaximus/tandem-mcp setup
```

That registers the MCP server with Claude Code, teaches it a few plain phrases ("make me a sprint board"), downloads the binary, starts it and opens the board. Then you ask any session to plan something, approve it, and open more terminals to work the queue. More at [tandemcanvas.com](https://tandemcanvas.com).

## What our first benchmark found

Tandem is our own harness, so it was the first thing we pointed Anybench at. The question was simple: does Tandem with three workers beat plain Claude Code?

It didn't. We ran both on the same three small coding tasks, with the same model, 18 trials each.<!-- source: README.md; docs/findings/trial-traces.md -->

|                         | Claude Code solo                                                | Tandem ×3<!-- source: README.md -->                             |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Passed the hidden tests | 94% (17/18)<!-- source: README.md -->                           | 89% (16/18)<!-- source: README.md -->                           |
| Average cost per trial  | $0.31<!-- source: README.md -->                                 | $2.32<!-- source: README.md -->                                 |
| Average time per trial  | 1m 11s<!-- source: README.md; docs/findings/trial-traces.md --> | 3m 57s<!-- source: README.md; docs/findings/trial-traces.md --> |

Solo Claude Code was more accurate, cheaper and faster. The traces show where Tandem's time went: 68% of its model time was spent in turns that only talked to the board, claiming, reporting and waiting.<!-- source: docs/findings/trial-traces.md --> On tasks this small, coordinating costs more than it saves.

One caveat goes with these numbers. The tokens went through Naïve's model proxy, which runs the model at its lowest effort with thinking off (`tokens: naive-proxy, effort: naive-min, thinking: off`). Every setup had the same handicap, so the comparison is fair, but it isn't Claude Code at its defaults. <!-- source: kits/tandem-vs-claude-code/README.md -->

## What's next

Small tasks are not what Tandem is for. Our bet is that it pays off on a whole-application build, the kind of job that outgrows one session's context. We're testing that next, under the same rules, and we'll publish the result either way.
