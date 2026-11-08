<p align="center">
  <img src="docs/assets/logo.svg" width="72" height="72" alt="Anybench logo">
</p>

<h1 align="center">Anybench</h1>

<p align="center">
  <b>An autonomous company that benchmarks your AI product.</b><br>
  Point it at your repo, ask “is it actually better?”, and walk away.
</p>

<p align="center">
  <a href="https://anybench.vercel.app">anybench.vercel.app</a> ·
  <a href="https://anybench.vercel.app/r/nx7pu8ghukog0aizc1uk">Example report</a> ·
  <a href="plan.md">Plan</a>
</p>

---

## What it does

You give Anybench a GitHub repo (an agent, MCP server, skill or harness) and one question. A fleet of agents does the rest:

1. **Understands** the project and what “better” should mean for it.
2. **Researches** what to compare it against: the obvious baselines and rivals.
3. **Designs an eval kit**: tasks, hidden tests the agent never sees, and the metrics that matter (success, time, cost).
4. **Proves the kit is fair** before spending anything: a reference solution must pass and a do-nothing contender must fail.
5. **Runs every setup** on its own cloud computer, repeated enough times to tell signal from noise.
6. **Grades** each attempt on a separate scoring computer, then reports with real statistics.
7. **Emails you** the result and a signed, shareable public page.

Even go-to-market is autonomous: outbound agents find projects worth benchmarking and draft the pitch. A person approves every send.

## Example: Tandem vs plain Claude Code

Same model (Claude Opus 5.5), same 3 tasks, 18 trials each.

| | Claude Code solo | Tandem ×3 |
|---|---|---|
| Success rate (hidden tests) | **94%** (17/18) | 89% (16/18) |
| Avg cost per trial | **$0.31** | $2.32 |
| Avg time per trial | **1m 11s** | 3m 57s |

Tandem is the founder’s own harness, and it lost. The traces show why: most of its model time went to coordinating its task board, not writing code.
[Full signed report →](https://anybench.vercel.app/r/nx7pu8ghukog0aizc1uk)

## Honest by construction

- **No speed or cost number without a correctness gate.** Only attempts that pass the hidden tests count.
- **No winner the stats don’t support.** Differences are tested (Holm-corrected); “not significant” is a valid answer.
- **Proof before trials.** Every kit must pass its oracle and fail its do-nothing check.
- **Full observability.** Every trial has a trace: each agent, model turn, tool call and board event on one timeline, plus why it failed.
- **Signed results.** Published reports are frozen and signed (Ed25519), with a public verification page.
- **You never pay for our failures.** Infra failures are retried and never billed.

## Pricing

Usage-based through Stripe: compute at cost plus a markup, and a small per-run fee. A full head-to-head benchmark like the one above costs about $17 before model tokens.

## How it’s built

| Part | Stack |
|---|---|
| Agents (understander, researcher, kit designer, skeptic, analyst, outreach) | Naïve managed agents |
| Trial and scoring computers | Naïve cloud computers |
| API | Hono on Node, zod contracts, Postgres (Neon) + Drizzle, graphile-worker |
| Web | Next.js on Vercel |
| Artifacts | Cloudflare R2 |
| Billing | Stripe metered usage (integer micro-USD everywhere) |

```
apps/
  server/    API, orchestrator (intake → kit → proof → trials → scoring → report), worker
  web/       live run page, results, public reports, billing
  cli/       anybench CLI (runs, outreach)
packages/
  core/      zod schemas and API contracts
  kit/       eval kit format and validation
  bench/     statistics and verdicts
  runner/    in-VM trial runner
  agents/    agent prompts and sessions
  naive/     Naïve SDK wrapper
  billing/   Stripe usage billing
  publish/   signed publications
  outreach/  outbound agents
kits/        curated eval kits (e.g. tandem-vs-claude-code)
```

## Develop

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
cp .env.example .env   # fill in what you need
pnpm build
pnpm dev:server        # API
pnpm dev:web           # web app
```

`pnpm test` runs the test suites. Agent and contributor instructions are in [CLAUDE.md](CLAUDE.md); findings about external systems are in [docs/findings/](docs/findings/).
