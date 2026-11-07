# Anybench: agent instructions

Anybench turns any project (agent, harness or software) into a benchmark. Agents generate the eval kit, eval computers run it, and the report says whether it's better and why.

## Before you start
1. Read `plan.md`. It's the spec and the ticket list. The product page is `docs/design/anybench-product-page.html`; the live copy is https://claude.ai/artifact/M8bMbjEZvXt7aThCJEMFnS.
2. Work comes from the **Tandem board** for this repo. Connect with the canvas code in `.tandem/canvas` (or the one the human gives you), then call `queue_next`, `task_claim`, `task_progress` and `task_complete`. Never work on a ticket you didn't claim, and never approve your own proposals.
3. Do one ticket per session, in a worktree: `git worktree add ../anybench-wt/<ticket> -b <ticket>`.

## Rules
- TypeScript, ESM, Node ≥ 22, pnpm workspaces. Validate every boundary with zod (`packages/core`).
- Money is **integer micro-USD** everywhere, the same convention as the Naïve SDK. Never use floats for money.
- **All of our own agent work runs on Naïve** (`@usenaive-sdk/managed-agents`, through `packages/naive`). We have $250 of Naïve credit. Anthropic and OpenAI keys are only for the *agent under test* inside a trial, or as a documented fallback.
- Naïve SDK docs are in `docs/reference/naive-*.md`. Read them before you call a method. Naïve `fs` ops are confined to `/home/naive`; use `exec` for system setup.
- Never commit secrets. Add every new env var to `.env.example`.
- No speed or quality number without a correctness gate. That's the product's core rule; keep it in the code too.
- Write what you learn about external systems (Naïve, Vultr, Claude Code in a VM) to `docs/findings/<topic>.md`, with the command you ran and what it printed.
- Done means the ticket's done condition is met and `pnpm -r build && pnpm -r test` passes. Put the commit hash in `task_complete`.
