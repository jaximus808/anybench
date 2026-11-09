# Anybench: build plan (v2, production)

> Point Anybench at any project (an agent, a harness, or any other software). Agents work out what it does, find what it should be compared against, and generate an eval kit. The kit runs on cloud computers built for that eval, and you get a score for each contender, the reasons behind it, and proof the test was fair. Then you **publish** it: a signed, embeddable result you can put on your site and in your README.

**Status:** building for production. v1 written 2026-11-07 for the YC Naïve hackathon; v2 the same day after four architecture reviews (eval computers, observability, billing and security, Tandem and the swarm). This file is the source of truth for the agent swarm; update it when a decision changes.

**Ships at:** `https://anybench.jaxonp.com` (web, Vercel) and `https://api.anybench.jaxonp.com` (API on Vercel Functions; always-on worker on an Oracle Cloud Always Free VM) with the database on **Neon** Postgres ($250 Neon credit).

**Acceptance test for the whole product:** benchmark **Tandem** (×1, ×3, ×5 workers) against plain Claude Code and Claude Code with subagents, end to end in prod, billed through Stripe (or comped by an admin), watched live, and published as an embeddable result (E14.4).

## 0. References

| What | Where |
|---|---|
| Product page (the "artifact"): site, app mock, mechanics, scope | https://claude.ai/artifact/M8bMbjEZvXt7aThCJEMFnS. Local copy: [`docs/design/anybench-product-page.html`](docs/design/anybench-product-page.html) |
| Build plan artifact (architecture, eval computers, epics) | https://claude.ai/artifact/2mE9VVQLY6DkpJYKjyyCNm |
| Market research | https://claude.ai/artifact/PcmEAn8KPKkkiNRVtqyt5h |
| Naïve TypeScript SDK (`@usenaive-sdk/managed-agents`) | https://usenaive.ai/docs/sdk/typescript. Local copies: [`docs/reference/`](docs/reference/) |
| Tandem (our build board, and acceptance subject) | `../agentcanvas`, https://github.com/jaximus808/tandem. Canvas `2BCM9U6Y` |
| Velocitty case (why correctness gates exist) | https://github.com/valvesky/velocitty/releases/tag/v1.3.0 and https://x.com/mitchellh/status/2115292243443519571 |

The artifact is the spec for **what the product looks like**. This file is the spec for **what we build and in what order**. When they disagree, fix one of them.

## 1. What changed in v2

| Area | v1 | v2 |
|---|---|---|
| Target | Hackathon demo | Production at anybench.jaxonp.com, usable and payable by strangers |
| Billing | Out of scope | **Usage-based Stripe billing**: card on file, metered usage, monthly invoice, credit grants spend first, admin grants for demos (section 8) |
| Publishing | Share link | **Publish pillar**: signed attestation, public benchmark page, SVG badge, iframe widget, OG image (P5) |
| Observability | "error log" | Core pillar: event store, SSE live run page, drill-down, agent introspection via MCP/CLI (section 6) |
| Alerts | One rule (70% credit) | Core pillar: rule engine, dedupe, ack, channels, auto-actions (section 7) |
| Kit | `adapter: {install, run}` | Seven wrapper layers, nine driver types (P2) |
| Eval computers | One base + fork | VM profiles per subject class, in-VM runner, scoring box, artifact transfer via S3, reaper (P1) |
| Orchestration | One state machine | Run and trial state machines, graphile-worker jobs, leases, crash recovery (section 5) |
| Competitors | Researcher lists baselines | **Competitor pass-through**: every baseline found gets an adapter, a smoke test, and runs in the same kit; failures get a postmortem (P4) |
| Tandem | Cookie trick | Approver policies `auto` (Tandem approval policy), `llm-reviewer` (Tandem peer review, cross-model), `human-sim` (cookie, epics only) |

## 2. Pillars

Every feature belongs to one of these. The promise: "Bring a GitHub repo, or a binary with its docs. We turn it into something testable, run it on computers built for the test, tell you whether it's better and why, and give you a result you can publish."

Product pillars: **P1** eval computers, **P2** eval kit, **P3** bench runners, **P4** results and investigation, **P5** publish.
Platform pillars: **O** observability, **A** alerts, **B** billing.

### P1. Eval computers

The agents choose the computer, not the user. It is never a plain empty VM.

**EnvSpec** (agent-written): `profile`, vCPU, memory, disk, OS packages, toolchains, `services` from the catalog, fixtures, declared network allow-list, health checks.

**VM profiles** (`packages/envs/profiles/*`). A profile is a base snapshot. The driver type picks the profile; the EnvSpec adds recipes on top.

| Profile | Contents | Provider | Default size |
|---|---|---|---|
| `scoring` | runner, test toolchains, reference parsers; never the subject | Naïve | 2 vCPU / 4 GB |
| `base` | node22, python3.12 + uv, git, GNU time, hyperfine, hey, k6, runner | Naïve | 2–4 vCPU |
| `agent-cc` | base + pinned `@anthropic-ai/claude-code`, non-root `eval` user, Tandem binary + pinned `@jaximus/tandem-mcp`, warmed npx cache | Naïve | 4 vCPU / 8 GB / 20 GB |
| `svc` | base + service recipes (postgres16, redis7, sqlite3, minio) | Naïve | 4 vCPU |
| `tui` | base + Xvfb, Mesa llvmpipe, xdotool, ffmpeg, terminal emulators, `pyte` reference parser | Naïve if spike 2.5 passes, else the Oracle worker VM or roadmap | 4 vCPU |
| `web` | base + chromium + Playwright | Naïve | 4 vCPU |
| `gui`, `docker`, `>16 vCPU`, GPU, long runs | — | roadmap (paid VMs later); small Docker evals via `docker-local` on the worker VM | per kit |

**Service catalog** (`packages/envs/recipes/<name>/{install.sh, healthcheck.sh, env.json}`): each recipe exports connection env vars (`DATABASE_URL`, `REDIS_URL`, ...). One generic recipe runner executes them.

**Build once, fork many.** Snapshot key = `sha256(base image + recipe versions + contender install hash)`. The **contender is installed into the snapshot**, not per trial, so install time and network jitter never enter a measurement. Forks get only secrets and the workload. Snapshots expire after 7 days; the baseline-sanity proof re-validates a rebuilt snapshot.

**In-VM runner** (`packages/runner`, compiled to one binary with `bun build --compile`, baked into every profile at `/home/naive/.anybench/bin/runner`):
- Started detached: `setsid nohup runner --trial <id> >> ~/eval/runner.log 2>&1 &`, because Naïve `exec` is capped at 10 minutes and kills attached children.
- Phases: `prepare → healthcheck → warmup → run → collect → freeze → upload → done`, each written to `~/eval/out/status.json`.
- Writes `machine.json` (lscpu, uname, nproc, meminfo, load_1m, steal) before `run`; enforces the driver's wall-clock cap; runs the approver sidecar for harnesses; enforces the BYOK token cap from stream-json.
- Pushes batched events and a 15 s heartbeat to `POST /v1/trials/:id/events` with a per-trial token. If egress is blocked, the worker polls `status.json` and `events.jsonl` by byte offset via `fs/read`.

**Secrets:** Naïve vault `env_var` returns 501, so secrets are written with `fs.write` to `/home/naive/.anybench/env` (0600) right before the trial. Never on an `exec` command line: Naïve stores command history unredacted for 30 days.

**Network:** `EnvSpec.network.allow` is *declared*, verified by a runner probe (allowed host + canary), not enforced on Naïve. Heavy VMs (roadmap) will get an enforced egress allow-list through cloud-init.

**Artifact transfer:** trial outputs go to our S3 bucket (Cloudflare R2, S3 API, free tier 10 GB, no egress fees) through presigned PUT/GET under `runs/<run>/trials/<trial>/`. The Naïve Files API (25 MiB cap) and base64 `fs/read` are too small or slow for 150 MB of scrollback.

**Providers behind one interface** (`ComputeProvider`): `naive` (default), `docker-local` on the worker VM for small Docker evals, a paid `vm` provider for heavy profiles later (roadmap), `docker-local` (dev, CI), `fake` (unit tests).

**Fairness:** contenders interleaved A B A B on the same profile; warm-ups discarded; repeats spread across computers; `load_1m` and `steal` recorded and trials over a threshold discarded; region pinned; every version (subject, Claude Code, model, Tandem) recorded in the trial.

**Cost shape:** Naïve bills 10-minute blocks in advance. Short software trials pack several interleaved trials onto one fork per block; agent and harness trials stay one per computer.

### P2. The eval kit: makes any software evalable

The kit is the single entry point for all testing. Agents write it; it is saved as plain files; a person can read and edit it; it reruns on the next release.

**Inputs:** a GitHub repo URL, **or** a binary (URL or upload) with its docs, **or** a Claude Code setup (`CLAUDE.md`, `.claude/`, `.mcp.json`). Ingest builds a `ProjectDigest`.

**Seven wrapper layers.** Every subject is wrapped the same way, so the eval computers never need to know what the subject is.

| Layer | `anybench.yaml` field | Files | Contract |
|---|---|---|---|
| L0 source | `contenders[].source` | — | `{github, ref}` · `{binary_url, sha256}` · `{upload}` |
| L1 install | `contenders[].install` | `adapters/<id>/install.sh`, `healthcheck.sh` | Runs at **snapshot build**. Exit 0 and the health check passes |
| L2 driver | `contenders[].driver` | `adapters/<id>/driver.sh` | Verbs `start`, `ready`, `run <in> <out>`, `stop`. Env `EVAL_IN`, `EVAL_WS`, `EVAL_OUT`, `EVAL_SECRETS` (a file path). `driver.type` picks the collectors |
| L3 workload | `workloads[]` | `workloads/<id>/{input/*, instruction.md, setup.sh}` | Deterministic bytes; `sha256` recorded per trial |
| L4 probes | `collectors[]` | built into the runner | `EVAL_OUT/metrics.jsonl`, `events.jsonl`, `machine.json`, `artifacts/` from `collect:` globs |
| L5 gate | `requirements[].gate` | `gates/<id>/check.sh`, `reference/` | Runs **only on the scoring computer**. Output `gate.json {pass, reason, evidence[]}` |
| L6 review | `requirements[].rubric` | `rubric.md` | Reviewer session with `output_schema`; quotes evidence paths |
| L7 proof | `proof` | `proof/{oracle, do_less, regression}/` | Each is a contender overlay (driver patch or env) run through L1–L5 |

Also in `anybench.yaml`: `subject {kind, name, summary, better_means[]}`, `vary` (each value is one setup), `human_in_loop {kind, policy}`, `secrets[]` (names only), `collect[]`, `transfer {max_mb}`, `scoring.weights` (sum 100), `repeats`.

**The core rule in code:** in `packages/core`, every `measured` requirement must name a `gate_id`, and `Score` only accepts metrics whose gate passed. A kit without an oracle for a measured gate does not validate.

**Driver types:**

| Class | `driver.type` | Driven by | Measured | Correctness gate | Profile |
|---|---|---|---|---|---|
| CLI tool | `cli` | hyperfine `--export-json`, `/usr/bin/time -v` | wall, CPU, peak RSS | stdout/file diff against the oracle's output | base |
| Service / API | `service` | `start` + `ready` URL; hey or k6 | p50/p95, RPS, RSS | golden request set → response diff; DB state check | svc |
| Library | `lib` | generated bench shim (tinybench, pytest-benchmark, criterion) | ops/s, allocations | property tests against a reference implementation | base + toolchain |
| Terminal emulator / TUI | `pty` | runner launches the emulator under Xvfb, streams `input.bin` through a PTY shim, appends a sentinel, waits until it's on screen | time to sentinel, bytes/s, RSS | **reference grid** from a VT parser (`pyte`) at the same rows × cols × scrollback; final screen diffed cell by cell, scrollback by line hash. Screen dump from the emulator's own export (kitty `@ get-text --extent=all`, alacritty ref-test), xdotool select-all as fallback | tui |
| GUI app | `x11` | xdotool scripts, screenshots | task time | accessibility tree (AT-SPI) or the app's export file. No frame rates | gui (roadmap) |
| Web app | `web` | Playwright + k6 | TTFB, p95, Lighthouse | DOM assertions + golden responses | web |
| Coding agent | `coding-agent` | `claude -p --output-format stream-json --verbose` on `instruction.md` in `EVAL_WS` | tokens, turns, cost, wall | hidden tests on the scoring computer | agent-cc |
| API / chat agent | `http-agent` | runner posts a conversation set; a simulated user is a reviewer-model session | latency, cost, outcome | labeled answers / oracle match | base |
| Harness with approvals | `harness` | `run.sh` + approver sidecar (`human_in_loop: {kind: tandem, policy}`) | tests passed, time, tokens, claims, conflicts, approvals | hidden tests on the scoring computer | agent-cc |

Do-less variants are class-specific: a PTY shim that drops every Nth 64 KiB chunk; a `CLAUDE.md` that says "skip the tests"; a 3-turn cap; an API that returns cached responses; a no-op harness (must fail hidden tests and show 0 claims).

**Six proof checks** must pass before any billed run: oracle passes; do-less fails the gate; smoke run passes on the real profile; planted regression scores lower; known baselines land in range; **no secret in the kit** (patterns plus exact values). The kit designer repairs a failing kit up to 2 times, then the run goes to `needs_human`.

### P3. Bench runners

- **Scheduler:** expands a kit into trials (contender × workload × repeat), interleaves contenders, caps concurrency (global `max_computers` from spike 2.1, per user, per run), enforces budgets, emits events.
- **Trial executor:** graphile-worker job `trial.execute`: fork snapshot → write secrets → start runner → watch heartbeats → collect → freeze → upload → destroy (or pack the next trial into the same paid block). It records `computer_id` on the trial row *before* any install so a retry never double-creates.
- **Collectors:** `/usr/bin/time -v`, hyperfine JSON, hey/k6, Claude Code stream-json (tokens, turns, cost), Naïve `proxy.calls`, machine info.
- **Gate runner:** a fresh scoring computer pulls frozen outputs by presigned URL, runs `gates/<id>/check.sh`, writes `gate.json`. It never ran the subject.
- **Reviewer agent:** scores reviewed requirements against the rubric with quoted evidence; a sample is scored twice and must agree within 1 point.
- **Approver** (`packages/approver`), for harnesses with a human gate:
  - `auto`: `PATCH /api/canvases/{code}/approval-policy {approvalPolicy:"auto"}` once per trial canvas. Tasks are born approved and stamped `policy:auto`.
  - `llm-reviewer`: Tandem `peer` policy with cross-model review; a Naïve reviewer agent on a different model approves via `task_review`, stamped `agent:<name>`.
  - `human-sim`: the local-cookie path (`GET /` sets `tandem_session`, then `POST /api/mcp/auth {code}` for a bearer, then `POST /api/canvas/actions/{id}/approve|reject`). Needed for **epic** approval under every policy, since epics stay human-only in Tandem.
  - Naïve `confirmTool` / `answer` prompts for agents under test.
- **Stats:** median and IQR, bootstrap 95% CI, pass@k and pass^k, effect size vs the baseline, weighted 0–100 score over gated metrics only.

### P4. Results, competitor pass-through and investigation

- **Competitor pass-through.** The researcher returns baselines with sources (competitors, the plain default, the last release). For each one, the intake agent writes an adapter (driver config + `install.sh`), smoke-tests it on the real profile, and either adds it as a contender or marks it `unavailable` with the reason (license, no Linux build, needs hardware). The test plan screen shows every candidate and why it was kept or dropped. The user can add or remove contenders.
- **Score** per contender with a per-requirement breakdown, confidence intervals, and wins and losses by workload.
- **Failure taxonomy.** Every failed trial is classified: `infra` (ours; retried, never billed), `subject` (the contender failed the task), `gate` (output didn't match the reference), `kit` (our grader or adapter was wrong), `budget` (hit a cap), `timeout`.
- **Investigator agent:** for the top deltas and every non-infra failure, it reruns with instrumentation (strace counts, py-spy or perf, query logs, Tandem board events) and writes **bottlenecks**: cause, evidence, suggested fix. Example findings: "merge conflicts on coupled files", "drops output beyond a 64 KiB ring", "N+1 queries".
- **Run postmortem:** for any run that ends `failed` or `needs_human`, a "what went wrong" section explains our own pipeline's failure (which stage, which agent, which error), so the user is never left with a dead run and no reason.
- **Report:** one-sentence answer, table, breakdown, where it breaks, bottlenecks, proof. Renders as a page, Markdown and JSON. The kit is saved so it reruns on the next release.

### P5. Publish: a result companies can embed and brag about

This is part of what customers pay for: a benchmark result they can put on their landing page, README and launch posts, that a skeptic can verify.

- **Signed attestation.** Publishing freezes the report into an immutable version and signs a canonical JSON with Ed25519: kit hash, contender versions, snapshot hashes, trial count, proof-check results, score, CI, timestamp. Public keys at `/.well-known/anybench-keys.json`. `anybench verify <url>` and the public page both verify it.
- **Honest by construction.** You can only publish a delivered run whose proof checks all passed. The public page always includes "where it breaks" and every contender; you can't publish a subset of workloads. A comped run carries a "comped" note.
- **Public benchmark page** `anybench.jaxonp.com/b/<owner>/<slug>`: the report, versions history, the proof, "Rerun this benchmark", "Download the kit". SEO and OG tags.
- **Badge** `api.anybench.jaxonp.com/badge/<slug>.svg`: variants `score`, `verdict` ("beats Claude Code +13"), `rank`. Edge-cached, links to the public page. Markdown and HTML snippets generated.
- **Embeddable widget** `anybench.jaxonp.com/embed/<slug>`: iframe results table or chart, light/dark/auto theme, auto-height through `postMessage`, a script-tag loader, and an oEmbed endpoint so Notion, Ghost, Medium and others unfurl it.
- **OG image** per published benchmark (Next.js `ImageResponse`) for X, LinkedIn and Slack.
- **Stays current.** "Rerun on next release" watches GitHub releases (webhook or polling) and reruns the saved kit. The published benchmark gets a new version; the badge shows the latest by default or a pinned version. The owner gets an alert on a regression before the new version is public (owner chooses auto-publish or review first).
- **Controls:** public or unlisted; unpublish (the badge then reads "withdrawn", never silently disappears); transcripts are never public, logs only if the owner opts in.
- **Embed analytics** for the owner: views and clicks per embed and badge.
- **Gallery** `/benchmarks`: published benchmarks, filterable by kind.

### O. Observability (core pillar)

Section 6.

### A. Alerts (core pillar)

Section 7.

### B. Billing (core pillar)

Section 8.

## 3. Everything around the pillars

- **Web** (`apps/web`, Next.js on Vercel): landing, sign-in, New run, Test plan, Live run, Report, Publish, public benchmark page, embed, Scan, Company, Billing, Settings (API keys, model keys, notifications), Docs, legal pages.
- **Control-plane API and worker** (`apps/server`, Hono; the **API runs on Vercel Functions** next to the web app, the **worker** runs as a long-lived Node process on an Oracle Cloud Always Free ARM VM (fallback: a Naïve computer)): REST + SSE, runner ingest, GitHub OAuth, Stripe and Naïve webhooks, graphile-worker jobs.
- **MCP server** (`packages/mcp`, stdio and streamable HTTP at `/mcp`): agents look into running evals (section 6).
- **CLI and Claude Code skill** (`apps/cli`): `anybench login | init | kit validate | run | watch | logs | report | publish | verify`, plus a `/anybench` skill that bundles a local repo or `.claude/` setup.
- **Database:** **Neon** serverless Postgres (16+) with Drizzle; $250 of Neon credit. Region `aws-us-east-1`, close to Vercel iad1 and Oracle us-ashburn-1. **Jobs:** graphile-worker (Postgres only, no Redis).
  - Two connection strings: `DATABASE_URL` is Neon's **pooled** endpoint (PgBouncer, transaction mode) for API queries; `DATABASE_URL_DIRECT` is the **unpooled** endpoint for migrations, graphile-worker and the event `LISTEN` connection. LISTEN/NOTIFY and session-level `SET` don't survive transaction pooling, so anything that LISTENs or holds a session must use the direct URL. RLS uses `SET LOCAL` inside a transaction, which is pooler-safe.
  - Neon branches: `main` = prod, `dev` = local development, and a throwaway branch per CI e2e run (created and deleted through the Neon API). Offline unit tests still use a local Docker Postgres.
  - Backups: Neon point-in-time restore (history retention window) plus a weekly `pg_dump | age` to object storage as an off-provider copy.
- **Object storage:** Cloudflare R2 (S3 API) for logs, transcripts, kits, artifacts, backups.
- **Company agents:** scout and account manager as Naïve deployments on schedules.
- **Outreach (GTM, E15):** Context.dev web search (`site:github.com` queries for perf/quality claims) plus the GitHub API find leads (Monid is an optional X-only source later; see the E15 hackathon cut) that need evals (agent builders, harnesses, CLIs and dev tools, perf claims with no gate) → scout scores fit → understander + researcher + kit designer pre-build a **free eval kit** from the public repo (no compute) → an insights brief (what they'd be compared against, what we'd measure, what to improve) → a personalized email from an AgentMail inbox with an invite link → `/i/<token>`: sign in with GitHub, see the kit, link a card, press Start evals → the account manager handles replies. Founder approves drafts at first; CAN-SPAM (unsubscribe, postal address, suppression list); funnel lead → emailed → clicked → signed in → card linked → run started → delivered → published on `/company`. Positioning against competing eval factories: a correctness gate on every number, competitor pass-through, signed publishable results.

## 4. Architecture

```
                 ┌───────────────────────────── Vercel ─────────────────────────────┐
  user ───────▶  │ apps/web  anybench.jaxonp.com                                      │
  embeds ─────▶  │ site · app · /b/<slug> public page · /embed/<slug> iframe · OG     │
                 └──────────────┬───────────────────────────────────▲──────────────┘
                                │ REST (cookie, same-site)           │ SSE /runs/:id/stream
                 ┌──────────────▼─ Vercel Fn (API) + Oracle VM (worker) ─┴──────────────┐
  agents ─MCP─▶  │ apps/server  api.anybench.jaxonp.com (Caddy TLS)                   │
  CLI ────────▶  │  Hono API ─────── graphile-worker (orchestrator, alerts) ── Neon  │
  Stripe ─hook─▶ │  /webhooks/stripe  /v1/trials/:id/events  /badge  /mcp            │
                 └──┬──────────────┬─────────────────┬──────────────┬───────────────┘
                    │ Naïve SDK    │ Naïve SDK        │ docker-local │ S3 API
         ┌──────────▼───────┐ ┌────▼──────────────┐ ┌─▼──────────┐ ┌─▼────────────────┐
         │ Naïve sessions   │ │ Naïve computers   │ │ Worker VM  │ │ Object storage   │
         │ our agents:      │ │ profile snapshot  │ │ gui/docker │ │ logs, transcripts│
         │ understander,    │ │ → fork per trial  │ │ GPU, >16   │ │ kits, artifacts, │
         │ researcher, kit  │ │ runner inside ────┼─┼─ pushes ───┼─▶ backups          │
         │ designer, review,│ │ fresh scoring box │ │ vCPU, long │ └──────────────────┘
         │ investigator ... │ └───────────────────┘ └────────────┘
         └──────────────────┘
```

### Repo layout (pnpm workspace, TypeScript, ESM, Node ≥ 22)

```
apps/
  web/            Next.js site + app + public pages + embed (Vercel)
  server/         Hono API + worker + Drizzle schema + migrations (API on Vercel Functions, worker on the Oracle VM)
  cli/            anybench CLI + /anybench Claude Code skill
packages/
  core/           zod schemas (one file per schema), state machines, events, API contract, money, redact
  naive/          wrapper over @usenaive-sdk/managed-agents + FakeNaive
  providers/      ComputeProvider + naive, docker-local, fake (vm provider later)
  envs/           recipes, profiles, EnvSpec builder, snapshot cache
  runner/         in-VM runner (bun-compiled binary)
  kit/            anybench.yaml loader/validator, ingest, drivers, proof checks, Harbor export
  agents/         prompt.md + output.schema.json + config.json per Naïve role
  bench/          scheduler, executor, collectors, gates, stats, scoring
  approver/       Tandem and Naïve human stand-ins
  report/         report builder, investigator integration, renderers
  publish/        attestation signing/verification, badge SVG, embed payloads
  billing/        usage ledger, Stripe client, meter events, credit grants
  alerts/         rule engine, channels, auto-actions
  mcp/            Anybench MCP server (stdio + HTTP)
kits/
  tandem-vs-claude-code/   acceptance kit (harness)
  honest-vs-cheater/       software head-to-head with a planted cheater
  terminal-throughput/     the Velocitty story: pty driver + reference grid gate
  scan-jaximus808/         GitHub scan of the local repos
docs/
  reference/  Naïve SDK docs   design/  product page   findings/  spike results   runbook.md
```

## 5. Orchestration

**Run state machine** (`runs.state`): `intake → understand → research → kit_draft → env_build → proof → awaiting_go → running → scoring → analyzing → delivered`, plus `failed`, `needs_human`, `paused_budget`, `cancelled`. `awaiting_go` auto-advances when the estimate fits the run budget and the billing gate passes.

**Trial state machine** (`trials.state`): `queued → forking → installing → warming → running → collecting → gating → reviewing → done | failed_infra | failed_subject | cancelled`. Only `failed_infra` retries (max 3, exponential backoff, `trials.attempt`). A `failed_subject` trial whose attempt froze a workspace (`trials.frozen_workspace`, read from the runner's manifest) is still graded on it and keeps its outcome: its hidden-test fraction counts as partial work, every gated metric counts it as a failed trial (TDM-232).

- The worker owns transitions; the API only enqueues commands. Both state machines are pure transition tables in `packages/core`, tested without a DB.
- **Jobs** (graphile-worker): `run.advance`, `trial.execute`, `trial.gate`, `env.build`, `agent.session.run`, `computer.reap`, `alerts.evaluate`, `credits.poll`, `usage.report`, `billing.reconcile`, `stripe.webhook`, `release.watch`, `publish.render`. Every job has `job_key = <table>:<id>:<attempt>`.
- **Idempotency:** Naïve sessions use `idempotencyKey = <agent_session_id>`; computers have no idempotency key, so `computer_id` is written before install and checked before any create.
- **Leases:** `trials.lease_owner`, `lease_until` (now + 90 s), refreshed every 30 s. The reaper (every 60 s) takes expired leases: re-attach if the computer is alive (re-read logs from the last offset), else `failed_infra` and retry. A worker restart never loses a trial, because workloads run under the detached runner, not a held `execStream`.
- **Cancellation and kill switch:** `runs.cancel_requested_at` and `kill_switches(scope: global|run|user)`, set by `ANYBENCH_PAUSE=1` or `/admin/kill`. Checked at every phase boundary and heartbeat. On cancel: `sessions.cancel` for live Naïve sessions, `computers.delete` for trial computers, trials → `cancelled`, `run.cancelled` event.

## 6. Observability (core pillar)

**One event model.** `events(id bigserial, run_id, seq, source, source_id, type, severity, actor, payload jsonb, cost_delta_micro_usd, at, UNIQUE(run_id, seq))`, validated by the zod `AnybenchEvent` union in `packages/core`.
- `source`: run, trial, agent_session, computer, ledger, alert, billing, publish, system.
- `type` (dotted): `run.state_changed`, `run.budget` (TDM-242: spent, committed, limit; cost delta = the change in spent), `trial.phase`, `trial.heartbeat`, `trial.log_chunk`, `trial.gate`, `agent.tool.started`, `agent.message`, `computer.created|destroyed|leaked`, `usage.recorded`, `alert.fired|acked|resolved`, `billing.payment_failed`, `publish.version_created`.
- Bulk bytes (stdout, stream-json transcripts, `tandem.db`, flamegraphs) live in object storage; `trial.log_chunk` carries `{offset, bytes, url}`. Naïve agent transcripts are mirrored into `agent_events(agent_session_id, naive_seq, type, payload)` and resumed with `afterSeq`.
- Retention: `events` 90 days, `agent_events` 30 days, object storage 1 year for paid runs and 30 days for free ones, published versions forever.

**Streaming.** `GET /runs/:id/events?after=<seq>` pages; `GET /runs/:id/stream` is SSE with `id: <seq>`, honoring `Last-Event-ID` by replaying from the table, then live. The worker `NOTIFY anybench_events '<run_id>:<seq>'` on insert; the API `LISTEN`s and fans out to open streams. The browser never talks to Naïve.

**The live run page** `/runs/[id]`: you can watch the whole eval from this one page.
- Real time: stage header (understand → research → kit → proof → running → scoring → analyzing, so the pre-trial work is visible too); four counters (done n/N, running now, spent vs cap with projected spend, elapsed and ETA); the tile grid (contender × workload × repeat, colored by phase); the spend burn-down; an **agents strip** (one chip per live Naïve session: role, elapsed, spend, last tool); the activity feed (filter by source and severity); the alert banner with ack.
- Drill-down 1, **trial drawer**: phase timeline, live log tail, transcript rendered from stream-json (turns, tool calls, tokens), metrics, gate result with the diff and evidence, machine info, computer id, provider and cost, Tandem board events for harness trials.
- Drill-down 2, **agent session** `/runs/[id]/agents/[sessionId]`: the Naïve transcript, budget vs spent, `stop_reason`, pending `confirmTool`/`answer` with an answer form, the output document.
- Drill-down 3, **computer** `/computers/[id]` (admin): status, owning trial, command list, `inspect` probe on demand.
- Polled every 15–30 s: Naïve `credits.show`, computer inventory, Stripe status.

**Agent introspection.** REST is the source; the MCP server and the CLI wrap it.
- MCP tools: `list_runs`, `get_run` (run + counters + alerts), `get_run_events({run_id, after_seq, types?})`, `watch_run({run_id, until, timeout_s})` (long-poll), `get_trial`, `tail_trial_log({trial_id, offset, bytes})`, `get_transcript({trial_id | agent_session_id, format})`, `get_computer`, `list_alerts`, `ack_alert`, `cancel_run` (write scope), `answer_agent` (write scope), `get_report`.
- CLI: `anybench watch <run>` (live counters + feed in the terminal), `anybench logs <trial> -f`.
- Auth: scoped API keys (`runs:read`, `events:read`, `logs:read`, `alerts:write`, `runs:write`, `publish:write`, `admin`), optionally limited to specific run ids. A Tandem worker can be handed a run-scoped read key.

**Platform observability (for us):** Sentry (errors and tracing for API, worker, web), pino JSON logs with redaction, an uptime monitor on `/health` and `/health/worker` (worker last-tick age, DB, Naïve balance), PostHog for product analytics (optional). `/admin/costs` shows per-run spend, Naïve `credits.show`/`spend`, and margin per run.

**Scope cut (founder, 2026-11-07): observability is for customers only.** Build what lets a customer see their runs: what's running, current state, what's working and what broke. That means 8.1 events + SSE (done), 8.2 agent session mirroring, 8.3 trial log streaming, 8.4 live run page, 8.5 trial drawer, the agent-session half of 8.6, 8.7 MCP and 8.8 `anybench watch`/`logs`. Internal tooling is out for now: 8.9 platform telemetry (Sentry/uptime), 8.10 `/admin/costs`, the admin computer view in 8.6, and platform-only alert rules and Slack/Tandem channels in 9.2/9.4. Money-safety pieces stay (spend caps, the 9.3 kill switch, the reaper).

## 7. Alerts (core pillar)

`alert_rules(key, scope, condition, severity, cooldown_s, auto_action)` and `alerts(rule_key, fingerprint, run_id?, severity: info|warn|critical|page, status: open|acked|resolved, first_seen, last_seen, count, acked_by, resolved_at, payload)`. Dedupe by `fingerprint = rule_key + scope_id` while open; repeats bump `count`. Evaluated by an `alerts.evaluate` job every 30 s and on matching events.

| Rule | Severity | Auto-action |
|---|---|---|
| Run spend ≥ 70 / 90 / 100% of its cap | warn / critical / page | 100%: no new trials (`paused_budget`), live ones finish |
| Naïve credit < $75 / < $25 left | critical / page | < $25: global kill switch |
| Trial heartbeat missed 3× | warn | reaper re-attaches or retries |
| Trial over 2× its estimated duration | critical | kill trial → `failed_infra` |
| Computer alive with no live trial for > 15 min | critical | destroy, `computer.leaked` |
| Infra failure rate > 30% over 10 trials | critical | pause run |
| Proof failed after 2 repairs | warn | run → `needs_human` |
| `needs_human` or a pending approval/answer for > 10 min | warn | — |
| Stripe `invoice.payment_failed`, dispute, early fraud warning | page | block new runs for that user |
| Unbilled usage over a user's limit | warn | require payment before the next run |
| Naïve webhook endpoint auto-disabled | critical | re-enable + test, else page |
| API 5xx > 2% over 5 min, `/health` failing | page | — |
| Published benchmark regressed on rerun | info (owner) | hold the new version for owner review |
| Usage ledger and Stripe disagree after reconciliation | critical | — |

**Channels** (`alert_channels`, `alert_deliveries` with retry): in-app (bell + run banner, always on), email (Resend), Slack incoming webhook, and for page-level infra alerts a `task_propose` on our Tandem build board so the swarm sees it. Customers get run-scoped alerts and run-finished notices ("Send results to Email and Slack"); the founder gets everything.

## 8. Billing (core pillar): usage-based, card on file, credit grants

**Model.** Users link a card once; usage accrues as they run; Stripe invoices it. Credits granted to a user are used up first, so they spend for free until the grant runs out. This is Stripe Billing usage-based pricing: **Billing Meter + metered price + subscription + credit grants**.

- **Link card:** Checkout Session `mode: "subscription"` with the metered price `STRIPE_PRICE_USAGE` (no upfront charge). It creates the Customer (`metadata.user_id`), saves the card, starts the subscription. Billing portal for cards, invoices and receipts.
- **Meter:** one meter, event name `anybench_usage`, value in **cents** (Stripe's unit); our internal ledger stays in micro-USD. Each trial fee and each managed-token charge is a meter event with `identifier = <usage_entry_id>` (Stripe dedupes on it).
- **Invoices:** monthly, plus a usage threshold (`USAGE_INVOICE_THRESHOLD_MICRO_USD`, $50) so new cards never build up large debts. Verify threshold behavior with meters in spike 2.7.
- **Credit grants:** `billing.credit_grants.create({customer, amount, applicability_config: {scope: {price_type: "metered"}}, category: "promotional" | "paid", expires_at?})`. Stripe applies them to metered invoices before charging the card. Signup grant (`SIGNUP_GRANT_MICRO_USD`, default 0 since E20: the free starter run replaced the $5 grant; GitHub accounts older than 90 days, once). Admin grants for demos and customers.
- **Free starter run (E20, TDM-223, `packages/billing/src/free-run.ts`).** An eligible account (GitHub account older than 90 days; email-only accounts never) gets one free benchmark with no card. Starter = at most 2 setups, at most `FREE_RUN_MAX_TRIALS` trials, BYOK tokens only (a stored Anthropic or OpenAI key; no contender on our Naïve proxy), projected compute at our cost (plus compute already used, e.g. an uploaded kit's proof) at most `FREE_RUN_CAP_MICRO_USD`. Go reserves the starter's cost (compute at our cost + the run fee for its kit origin as our agents' allowance) from the global pool `FREE_RUN_POOL_MICRO_USD` in one conditional UPDATE, so concurrent presses never oversubscribe it; when it cannot cover a starter, free runs pause and the site shows normal pricing. When the run ends, a real outcome (delivered, subject-failed, user-cancelled) consumes the entitlement and its run fee and compute are covered by a `free_run` credit grant (entries stamped `free_run:<grant>`, never sent to Stripe); an infra or pipeline failure, or our cancel, releases it. The pool gets the reservation back and records what the run actually cost us. The correctness gate and statistics are unchanged.
- **No card for the free run (E20, TDM-224).** POST /runs/:id/go tries the free run first (apps/server `lib/free-run.ts` freeRunAtGo → reserveFreeRun); reserved = Go with no card, even with a card on file. Skipped for a comped or admin run and under BILLING_MODE=off. Otherwise the card gate decides as before, and its 402 adds `free_run: {reason, reasons, message}` in plain words (a starter limit, the free run already used or in use, `pool_exhausted` "free runs are paused right now"); a run that moved is a 409. The reservation and the transition are separate transactions, so a Go that reserved and then fails to leave awaiting_go calls releaseFreeRun. The billing summary carries `free_run` (available / in_use / used / not_eligible / paused, has_model_key, limits). A running free run whose computers reach FREE_RUN_CAP_MICRO_USD (our cost) is held in `paused_budget`. Sign-up lands on `/welcome`: the user's Anthropic or OpenAI key (write-only `PUT /secrets/:provider`, user_secrets), the free run, an optional card (the same Stripe Checkout), then `/runs/new`.
- **What we bill (cost-plus, founder decision 2026-11-07):** `RUN_FEE_MICRO_USD` ($2 per benchmark run, covering our Naïve agents) + **eval computer time at Naïve cost + `COMPUTE_MARKUP_BPS` (50%)**, metered from the `computers` registry in 10-minute blocks (Naïve rate: $0.0504/vCPU-h + $0.0162/GiB-h). If our infrastructure or pipeline fails the run, nothing is billed (no fee, no compute); `failed_infra` attempts are never billed; a run that fails on the subject pays the fee and compute; a user cancel mid-run pays the compute used but no run fee, a cancel we cause (kill switch, auto-action, admin) bills nothing. Model tokens are on the user's own key by default; optional managed tokens through the Naïve proxy at cost + `MANAGED_TOKEN_MARKUP_BPS` (20%), billed once per trial when the run ends from the trial key's Naïve spend, under the compute rules (never for infra failures or our cancels), and metered to Stripe like compute; a kit on managed tokens needs a card on file at Go (TDM-244). Worked examples: Tandem benchmark (60 agent trials × ~30 min on 4 vCPU/8 GB) = 30 computer-hours × $0.4968/h (4 × $0.0756 + 8 × $0.0243, cost +50%) ≈ $15 compute + $2 ≈ $17 + tokens (more if trials spill into an extra 10-minute block); a CLI/API benchmark ≈ $2–4.
- **Our ledger** (`packages/billing`): `usage_entries(id, user_id, run_id, trial_id?, type: run_fee|compute|managed_tokens|adjustment|refund, amount_micro_usd, stripe_meter_event_id?, reported_at?, idempotency_key UNIQUE)`, `credit_grants(id, user_id, stripe_credit_grant_id, amount_micro_usd, category, reason, intervention_id?, expires_at)`, `billing_accounts(user_id, stripe_customer_id, subscription_id, payment_status: none|ok|past_due|blocked, has_payment_method, unbilled_micro_usd, granted_remaining_micro_usd)`, `stripe_events(id = evt_…, type, payload, processed_at)`. It drives the live "spent" counter, caps and the run gate. Cents ↔ micro-USD: `micro = cents × 10_000` exactly; to Stripe, `cents = floor(micro / 10_000)` with the remainder carried to the next event. Never floats.
- **Run gate on Go:** allowed when `payment_status = ok` and (`has_payment_method` or granted credit covers the estimate) and the estimate keeps unbilled usage under the account's limit (`NEW_ACCOUNT_SPEND_LIMIT_MICRO_USD` until the first paid invoice) and the daily cap. Otherwise `402 {reason, link_card_url}`; the run waits in `awaiting_go` and resumes when the webhook lands.
- **Mid-run:** per-run cap → `paused_budget`. Payment failure → block new runs, let live trials finish.
- **Every run's budget (TDM-242, apps/server `orchestrator/budget.ts`).** "Budget $20" means Anybench never charges more than $20 for the run. `runs.spent_micro_usd` = run fee (from the first trial) + compute at billed price (destroyed computers at registry cost, live ones at the blocks paid so far, +COMPUTE_MARKUP_BPS per computer; computers that served only failed_infra or cancelled trials never count) + managed tokens (Naïve proxy spend; its cap when unreadable); `committed_micro_usd` = the trials launched and not finished, each at its worst case (wall-clock cap + every verb at its timeout + boot, minus what its computer already spent) plus its managed-token cap. BYOK tokens are the user's provider's bill: `byok_token_micro_usd`, reported, never limiting. A launch (queued → forking) is admitted in the trial store under the run's row lock only when spent + committed + its cap fits; otherwise it stays queued (`held`). Running trials finish. With queued trials left, none fitting and nothing in flight → `paused_budget` (reason names spent, committed, the next cap and the limit); spent alone past the limit while trials run → `paused_budget` plus `budget_stop`, and each runner stops its subject (`~/.anybench/budget-stop`, failed_subject `budget`, workspace frozen and graded). Scoring and analysis are never held. A free run is the same mechanism on basis `free_run`: compute at our cost against FREE_RUN_CAP_MICRO_USD. `POST /runs/:id/resume` (optionally raising the budget) continues a held run (not a free run); settling a held run scores what it has. At terminal, spent = the ledger's charges.
- **Webhooks** (`/webhooks/stripe`, raw body, signature verified, `stripe_events` insert first for idempotency): `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.finalized|paid|payment_failed|payment_action_required`, `payment_method.attached|detached`, `charge.refunded`, `charge.dispute.created|closed`, `radar.early_fraud_warning.created`, `billing.credit_grant.created|updated`.
- **Reconciliation** (nightly): our unreported usage entries are reported; reported totals vs Stripe meter event summaries; our Naïve cost vs `credits.spend`. Any difference fires an alert.
- **Demo bypass (founder).** Never a mode in prod. Two admin actions, each writing an `interventions` row in the same transaction (a DB trigger rejects a grant or comp without one):
  - `POST /admin/users/:id/grant {amount_micro_usd, reason}` → a Stripe credit grant + `credit_grants` row.
  - `POST /admin/runs/:id/comp {reason}` → the run's usage is recorded with `comped_by` and never sent to Stripe. Comped runs show "comped" on the report and `/company`.
  - Admin = `ADMIN_GITHUB_LOGINS`, checked per request against `users.github_login`.
- **Modes.** `BILLING_MODE=off` (local only; refuses to boot when `NODE_ENV=production`), `test`, `live`. Boot asserts the key prefix matches the mode. Prod runs `test` until the cutover ticket (E10.10), then `live`.
- **Taking money for real** needs: `/terms`, `/privacy`, `/refunds`, `/aup` linked in the footer and Checkout; Stripe account activation; statement descriptor `ANYBENCH`; Radar on.

## 9. Security and tenancy

- **Auth:** GitHub OAuth in the API (`/auth/github`, HMAC'd state cookie, callback `https://api.anybench.jaxonp.com/auth/github/callback`). Opaque session token stored hashed in `sessions`. Cookie `anybench_session; Domain=.anybench.jaxonp.com; Secure; HttpOnly; SameSite=Lax`. Web and API are same-site, so the cookie rides `fetch(..., {credentials: "include"})` and SSE.
- **CORS** exact origin from `ALLOWED_ORIGINS` with credentials; **CSRF**: mutating requests must carry an allowed `Origin`.
- **API keys:** `ab_live_` / `ab_test_` prefixes, sha256-hashed, shown once, scoped, revocable.
- **Tenancy:** every tenant table has `owner_id`; every query goes through `scopedDb(actor)`; Postgres RLS on `runs, kits, trials, reviews, reports, events, user_secrets` with `SET LOCAL app.actor_id` as defense in depth.
- **Customer model keys (BYOK):** envelope encryption: `ANYBENCH_KEK` wraps a random per-secret key; AES-256-GCM; stored with `kek_version` and `last4`; write-only API. Decrypted only right before a trial and written to the VM via `fs.write`.
- **Redaction** (`packages/core/redact.ts`) before anything is persisted: patterns for `sk-ant-`, `sk-`/`sk-proj-`, `gh[pousr]_`, `[sr]k_live_`, `whsec_`, plus exact match on every secret in scope for that trial. Pino redacts auth headers and cookies; Sentry `beforeSend` scrubs.
- **Abuse:** eval computers run strangers' code. No compute without a card on file or a grant; grants only for GitHub accounts older than 90 days; per-trial wall-clock cap; per-user concurrency, runs per day and daily spend caps; the reaper; egress allow-lists on heavy VMs (roadmap); the AUP forbids mining. Per-IP rate limits on `/auth/*`, `/b/*`, `/badge/*`, `/embed/*`, `/webhooks/*`.

## 10. Data model (Postgres, Drizzle; one file per table)

- Identity: `users(id, github_login, github_id, github_created_at, email, is_admin_cache)`, `sessions`, `api_keys(id, owner_id, name, prefix, hash, scopes[], run_ids[], expires_at, last_used_at, revoked_at)`, `user_secrets(owner_id, provider, ciphertext, iv, tag, wrapped_dek, kek_version, last4, last_used_at)`.
- Benchmarks: `projects(id, owner_id, source, url, digest, kind)`, `runs(id, owner_id, project_id, question, state, budget_micro_usd, spent_micro_usd, estimate_micro_usd, kit_id, next_seq, cancel_requested_at, paused_reason, comped_by, comped_reason)`, `kits(id, run_id, version, spec, files_url, proof, hash)`, `contenders(id, run_id, kit_id, source, role, status: candidate|kept|unavailable, reason, found_by)`, `envs(spec_hash, profile, provider, snapshot_id, built_at, expires_at, health)`, `trials(id, run_id, contender_id, workload_id, repeat, attempt, state, lease_owner, lease_until, computer_id, provider, started_at, ended_at, machine, metrics, gate, failure_class, exit_code, log_offset, cost_micro_usd, logs_url)`, `reviews(trial_id, criterion, score, evidence, review_session_id)`, `reports(run_id, json, md)`, `bottlenecks(run_id, cause, evidence, suggested_fix, trial_ids[])`.
- Agents: `agent_sessions(id, run_id, role, naive_session_id, budget_micro_usd, cost_micro_usd, status, last_seq, stop_reason, pending_action)`, `agent_events(agent_session_id, naive_seq, type, payload)`.
- Compute: `computers(id, provider, provider_id, run_id, trial_id, snapshot_id, status, created_at, destroyed_at, blocks_billed, cost_micro_usd, last_seen_at)`.
- Observability and alerts: `events`, `alert_rules`, `alerts`, `alert_channels`, `alert_deliveries`, `kill_switches`, `webhook_inbox(provider, event_id UNIQUE, received_at, processed_at, payload)`.
- Billing: `billing_accounts`, `usage_entries`, `credit_grants`, `stripe_events`, `cost_entries(source: naive|vm|storage|vercel, run_id?, amount_micro_usd, at)` (our COGS), `free_starter_runs(user_id, run_id, state: reserved|consumed|released, reserved_micro_usd, agent_allowance_micro_usd, pool_spent_micro_usd, covered_micro_usd, release_reason)` and `free_run_pool(id = global, reserved_micro_usd, spent_micro_usd)` (TDM-223, the free starter run).
- Publish: `published_benchmarks(id, owner_id, slug UNIQUE, run_id, visibility: public|unlisted|withdrawn, pinned_version?, auto_publish)`, `publish_versions(id, benchmark_id, version, report_json, attestation, signature, key_id, created_at)`, `embed_views(benchmark_id, kind: badge|embed|page, referrer_host, day, count)`.
- Company: `interventions(id, run_id?, user_id?, who, what, why, at)`.
- Outreach: `leads(id, source, query, company, contact, email, github_url, signals, fit, status, digest_id?, kit_id?, brief)`, `outreach_messages(id, lead_id, kind: initial|followup|reply, subject, html, text, status: draft|approved|sent|bounced|replied, agentmail_message_id, approved_by, sent_at)`, `invites(token_hash, lead_id, run_id, expires_at, clicked_at, claimed_by)`, `suppressions(email, reason, at)`.

## 11. Agents (all on Naïve)

All of our own agent work runs as Naïve agents and sessions, paid from the **$250 Naïve credit**. Prompts live in `packages/agents/<role>/{prompt.md, output.schema.json, config.json}`; `packages/naive` creates or updates each agent on deploy, so a prompt change makes a new agent version.

| Role | Input → output | Notes |
|---|---|---|
| understander | ProjectDigest → `{kind, summary, better_means[], risks[], benchable: ready|needs_hardware|skip, reason}` | Also used by the scan |
| researcher | digest + summary → `{baselines[{name, source, why, install_hint, published_numbers[]}], sources[]}` | Competitors, plain default, last release. Cites sources |
| intake | baseline → adapter (driver config + install.sh) + smoke result | Competitor pass-through |
| env designer | digest + kit draft → EnvSpec (profile + recipes) | |
| kit designer | all of the above → KitSpec + workloads + gates + rubric + weights | Repairs after proof failures (max 2) |
| verifier | proof results → explanation of failures | Checks are code; the agent explains |
| reviewer | trial outputs + rubric → per-criterion scores with quoted evidence | Different model from the agent under test |
| investigator | deltas + failures + instrumented reruns → bottlenecks | Requests instrumented reruns |
| analyst | computed stats → answer sentence + where it breaks + postmortem | Numbers come from code |
| scout (company) | public signals → leads + outreach drafts | Naïve deployment on a schedule |
| account manager (company) | delivered report → email, follow-ups, rerun scheduling | Naïve deployment |

**Guards:** each run has `budget_micro_usd`; each Naïve session gets `budget_micro_usd` on `sessions.create`; the global kill switch; computers destroyed after each trial and reaped when orphaned; all money is integer micro-USD.

## 12. Production

| Piece | Where | How |
|---|---|---|
| `apps/web` | Vercel, `anybench.jaxonp.com` | GitHub integration; prod env in Vercel; `NEXT_PUBLIC_*` only for public values |
| API (`apps/server` Hono app) | Vercel Functions (Node runtime), `api.anybench.jaxonp.com` as a second Vercel project or a rewrite | Request/response routes: REST, runner ingest, webhooks, badge, MCP. **SSE** streams poll `events` by seq (~1 s) for up to the function max duration, then the client reconnects with `Last-Event-ID` (already in the design). Needs Vercel Pro for commercial use |
| Worker (`apps/server` worker entry) | Oracle Cloud Always Free Ampere VM (Ubuntu ARM, about 2 OCPU / 12 GB after the June 2026 cut), outbound-only | One image (GHCR, arm64), Docker Compose: `migrate` (one-shot) and `worker`; systemd restart; no inbound ports except SSH. Fallback: the worker on a Naïve computer from the $250 credit |
| Database | Neon Postgres, project `anybench`, region aws-us-east-1 | `main` branch for prod, `dev` branch for local, per-CI-run branches; pooled URL for the API, direct URL for worker, LISTEN and migrations |
| Eval computers | Naïve (default, 1–16 vCPU); `docker-local` on the worker VM; heavy VMs on the roadmap | `packages/providers` |
| Agents | Naïve | synced on deploy |
| DNS (jaxonp.com zone) | registrar/DNS host | `anybench` CNAME `cname.vercel-dns.com`; `api.anybench` CNAME → Vercel (API project); Resend SPF/DKIM/DMARC |
| Secrets | `.env` locally (fill-in sheet at repo root), Vercel env, `/etc/anybench.env` on the worker VM (root, 0600) | Never committed. `.env.example` lists every key |
| Backups | Neon point-in-time restore + weekly `pg_dump | age` → object storage (off-provider copy), monthly restore drill into a Neon branch | `BACKUP_AGE_RECIPIENT` |
| Migrations | `drizzle-kit generate` SQL committed; `migrate` runs before `server` | never `push` in prod |
| CI/CD | GitHub Actions: build, typecheck, test → image → deploy on `main` | Vercel deploys web |

`pnpm smoke:prod` runs honest-vs-cheater end to end against production (Stripe test mode or a comped run, alerts delivered, publish + badge render) and must pass before launch. `docs/runbook.md` covers deploy, rollback, kill switch, key rotation, test→live cutover, incidents.

## 13. Scope

**In:** the three kinds of project through one entry; drivers `cli`, `service`, `lib`, `coding-agent`, `http-agent`, `harness`, `pty`, `web`; the six proof checks and a correctness gate on every measured number; competitor pass-through; the written "why" and postmortems; publish (attestation, page, badge, embed, OG); observability and alerts; usage-based Stripe billing with credit grants and admin bypass; GitHub scan; CLI, MCP and skill; production deploy.

**Later (roadmap):** `x11` GUI driver beyond correctness checks; GPU frame-rate benchmarks; mobile, robotics and hardware; hosting model weights; teams, orgs and SSO; public leaderboards where others submit contenders to someone else's kit; Tandem `sim:<policy>` approval stamp and `task.proposed` webhook (a Tandem change).

## 14. Verify first (spikes, E2)

Write the answers to `docs/findings/<topic>.md` with the command and what it printed.

1. **Naïve computers** (`naive-computers.md`): root or sudo for `apt`? Docker inside? OS image and glibc? Which user does `exec` run as? Do `setsid` processes survive across `exec` calls and for 45 minutes? Fork latency and concurrent-computer cap? Outbound network limits, inbound ports? Rate card per size per 10-minute block (fixes `TRIAL_FEE_MICRO_USD`)? Is anything we write via `fs` or `exec` logged?
2. **Claude Code in a Naïve computer** (`claude-code-in-vm.md`): install as a non-root user; `claude -p --output-format stream-json --verbose` runs; `--dangerously-skip-permissions` as root needs `IS_SANDBOX=1`; Naïve Anthropic proxy with `ANTHROPIC_BASE_URL`.
3. **Naïve agents** (`naive-agents.md`): `harnesses.list`, `models.list`, web search for the researcher, `output_schema`, `credits.show`, plan active.
4. **Tandem headless** (`tandem-headless.md`): the binary under `up --foreground`, `TANDEM_AUTOSTART=0`, `PORT`, `TANDEM_DATA_DIR`, `CLAIM_TTL_MINUTES`; `approval-policy auto` PATCH; the cookie approve sequence for epics; peer review with cross-model.
5. **TUI in a micro-VM** (`tui-in-vm.md`): Xvfb + Mesa llvmpipe; which terminal emulators install; screen and scrollback dump per emulator; `pyte` reference grid at 150 MB.
6. **Hosting without Vultr** (`hosting.md`): Hono on Vercel Functions (max duration, SSE streaming + reconnect, cold starts, Neon pooled connections from functions); the Oracle Always Free ARM VM (actual free shape after the 2026 change, idle-reclaim policy, Docker, outbound to Neon/Naïve/Stripe); Cloudflare R2 presigned PUT/GET of a 200 MB file from a Naïve computer.
7. **Stripe usage billing** (`stripe.md`): in a Stripe sandbox, a meter + metered price + subscription via Checkout; meter event dedupe on `identifier`; credit grant applied to the next invoice; threshold billing with meters; webhook sequence.

## 15. Work breakdown

The Tandem canvas `2BCM9U6Y` (http://127.0.0.1:7891/c/2BCM9U6Y) holds every ticket below. Ticket titles start with their id (`[3.4]`), and bodies name the surface, the done condition and the tickets they depend on.

**Approve in waves.** Approving an epic approves every ticket in it, and Tandem has no dependency field, so the human approves epics in this order and workers skip a ticket whose dependencies aren't done (they `task_progress` "blocked by X" and take another):

| Wave | Epics | Why |
|---|---|---|
| 0 | E0 human setup | keys unblock spikes |
| 1 | E1 contracts and scaffold | everything imports these; lands before fan-out |
| 2 | E2 spikes, E3 eval computers, E4 eval kit, E5 bench runners, E7 control plane | parallel fronts on frozen contracts, testable offline with fakes |
| 3 | E6 agents, E8 observability, E9 alerts, E10 billing, E11 web and CLI, E15 outreach | need the API and events |
| 4 | E12 publish, E13 ship | need reports and a deployed API |
| 5 | E14 acceptance | the Tandem benchmark in prod, scan, launch |

Rules for parallel workers: each ticket owns a directory and lists the shared files it may touch; one schema per file in `packages/core`, one table per file in the Drizzle schema, one router file per resource in `apps/server`; migrations named by timestamp; `.env.example` changes only in the section for your package.

### E0. Human setup (assignee: human)
TDM-1 Naïve key + plan · TDM-2 Vultr (dropped: no free credit; see H14/H15) · TDM-3 Vercel link + GitHub repo · TDM-4 GitHub OAuth app · TDM-5 Anthropic/OpenAI keys (domain decided: anybench.jaxonp.com). Added in v2: H6 Stripe account, sandbox and activation · H7 DNS records on jaxonp.com · H8 Resend, Slack webhook, Sentry · H9 Vultr object storage + backup age key · H10 GitHub repo created and initial commit pushed · H11 confirm pricing after the rate card · H12 Monid and AgentMail keys + outreach settings. (TDM-144..150)

### E1. Contracts and scaffold
1.0 monorepo scaffold + CI · 1.1 core kit and env schemas (KitSpec v2 with layers and drivers) · 1.2 core run/trial state machines + event schema · 1.3 core money, ids, redact · 1.4 core API contract (zod routes) · 1.5 Drizzle schema, migrations, `scopedDb`, RLS · 1.6 `ComputeProvider` + FakeProvider + contract test suite · 1.7 `packages/naive` + FakeNaive · 1.8 server skeleton (config, /health, pino, Sentry, graphile-worker).

### E2. Spikes
2.1 Naïve computers · 2.2 Claude Code in VM + proxy · 2.3 Naïve agents · 2.4 Tandem headless + approvals · 2.5 TUI in micro-VM · 2.6 Vultr (superseded by 2.8 hosting spike) · 2.7 Stripe usage billing.

### E3. Eval computers (P1)
3.1 naive provider · 3.2 docker-local provider · 3.3 vultr provider (deferred to roadmap) · 3.4 recipe runner + base recipes · 3.5 service recipes · 3.6 agent recipes (claude-code, tandem, playwright) · 3.7 tui recipes · 3.8 EnvSpec builder + snapshot cache · 3.9 VM profiles · 3.10 computer registry + reaper · 3.11 artifact transfer (S3 presigned).

### E4. Eval kit (P2)
4.1 loader/validator + folder layout · 4.2 ingest GitHub · 4.3 ingest binary + docs + Claude Code setup · 4.4 driver `cli` · 4.5 driver `service` · 4.6 driver `lib` · 4.7 driver `coding-agent` · 4.8 driver `http-agent` · 4.9 driver `harness` + Tandem adapter · 4.10 driver `pty` + reference grid gate · 4.11 driver `web` · 4.12 proof checks + repair loop · 4.13 Harbor export.

### E5. Bench runners (P3)
5.1 in-VM runner · 5.2 runner ingest endpoint · 5.3 scheduler · 5.4 trial executor · 5.5 collectors · 5.6 gate runner on the scoring computer · 5.7 approver policies · 5.8 stats and scoring · 5.9 run orchestrator + crash recovery.

### E6. Agents on Naïve
6.1 agent registry + session persistence · 6.2 understander · 6.3 researcher · 6.4 competitor pass-through (intake) · 6.5 env designer · 6.6 kit designer · 6.7 reviewer · 6.8 analyst · 6.9 investigator + failure taxonomy · 6.10 run postmortem.

### E7. Control plane API
7.1 GitHub OAuth + sessions + CORS/CSRF + admin · 7.2 API keys · 7.3 runs routes · 7.4 uploads · 7.5 reports routes · 7.6 BYOK secrets · 7.7 offline end-to-end integration test.

### E8. Observability
8.1 event writer + NOTIFY + SSE · 8.2 Naïve session mirroring · 8.3 trial log streaming · 8.4 live run page · 8.5 trial drawer · 8.6 agent session + computer views · 8.7 MCP server · 8.8 `anybench watch` / `logs` · 8.9 platform telemetry · 8.10 `/admin/costs`.

### E9. Alerts
9.1 engine · 9.2 rules pack · 9.3 auto-actions + kill switch · 9.4 channels · 9.5 notification preferences + run-finished notices.

### E10. Billing
10.1 usage ledger · 10.2 Stripe client + meter/price setup script · 10.3 link card (Checkout subscription) + billing portal · 10.4 webhook handler · 10.5 meter event reporter · 10.6 run gate + caps · 10.7 credit grants (signup + admin) + interventions · 10.8 comp runs + admin UI · 10.9 billing page (usage, grants, invoices) · 10.10 reconciliation · 10.11 test→live cutover.

### E11. Web app and CLI
11.1 web scaffold + tokens + API client · 11.2 landing page · 11.3 sign-in + settings · 11.4 New run · 11.5 Test plan · 11.6 report page · 11.7 scan · 11.8 company · 11.9 legal + docs pages · 11.10 CLI · 11.11 `/anybench` skill.

### E12. Publish (P5)
12.1 attestation signing + verify · 12.2 publish flow + versions · 12.3 public benchmark page · 12.4 badge SVG · 12.5 embed widget + oEmbed + script loader · 12.6 OG image · 12.7 publish dialog UI · 12.8 rerun on release + regression hold · 12.9 embed analytics · 12.10 gallery.

### E13. Ship
13.1 worker image + compose (no Caddy/postgres) · 13.2 (superseded by 13.11) · 13.10 API on Vercel Functions · 13.11 Oracle worker VM provisioning + deploy · 13.3 backups · 13.4 CI/CD · 13.5 Vercel prod on anybench.jaxonp.com · 13.6 security review · 13.7 `smoke:prod` · 13.8 runbook.

### E14. Acceptance and launch
14.1 kit honest-vs-cheater · 14.2 kit tandem-vs-claude-code · 14.3 kit terminal-throughput · 14.4 Tandem benchmark in prod, published · 14.5 GitHub scan + 2 delivered reports · 14.6 company agents + `/company` · 14.7 launch checklist.

### E15. Outreach (GTM)
15.1 Monid + AgentMail spike · 15.2 leads schema + Monid sourcing + GitHub signals · 15.3 scout scoring + free pre-built kit · 15.4 insights brief · 15.5 personalized drafts + founder approval queue · 15.6 AgentMail sending, limits, suppression, webhooks · 15.7 invite links to a ready-to-run kit · 15.8 account manager replies · 15.9 funnel metrics · 15.10 compliance and deliverability. (TDM-134..143)

**Hackathon cut (decided 2026-11-07).** Goal: the first founder-approved emails go out the morning of 2026-11-08, sent by the company's own agents. The original tickets wait on E6 agents, the E7 API, E10 billing and the E11 web app, none of which exist yet. So the cut removes those dependencies and keeps everything else in the plan:

| Change | Why |
|---|---|
| **Lead source: Context.dev, not Monid.** `web-search` with `site:github.com` + claim phrases ("faster than", "benchmark", "-N% tokens", "Claude Code harness") and `freshness`; `people-enrich` (returns email) only for leads that pass the fit check; GitHub REST API for repo signals. Monid stays an optional X-only source. | Already have Context.dev credits (543 as of 2026-11-07, refills 1,000 on 11-29); a test search returned ideal leads (perf claims with no gate). Monid's docs don't confirm email lookup or GitHub. |
| **Hackathon opt-in import.** `anybench outreach import <csv> --source hackathon_optin` (name, email, repo) from attendees who replied to the chat post. | Opt-in beats scraping attendee LinkedIns (ToS risk, wrong-person matches). No LinkedIn scraping, no GitHub commit-email harvesting. |
| **Scout writes a claim brief, not a pre-built kit.** One Naïve scout session: lead + `ProjectDigest` (4.2, done) → fit, the claims they make (each cited to a README/repo line), what we'd measure, the gate we'd use, what they'd be compared against. | The full pre-built kit needs 6.2/6.3/6.6. That stays as 15.3 for after E6. |
| **Approval queue is a CLI**, `anybench outreach review` (approve / edit / reject, `approved_by` + `interventions` row). | `/admin/outreach` needs 11.1 + 7.1. The web page stays as 15.5 for later. |
| **CTA is "reply and we'll run it"**, not an invite link. | `/i/<token>` needs E10 + E11.5. Stays as 15.7. |
| **Replies by polling AgentMail, not webhooks.** Unsubscribe is reply-based (`List-Unsubscribe: <mailto:…?subject=unsubscribe>`) plus the postal address. | No public API deployed yet (E13). CAN-SPAM accepts a working reply address as the opt-out mechanism. |
| **Sending domain:** the custom subdomain if H7 DNS is done in time, otherwise the AgentMail default domain. Dry-run by default; `--send` required; `OUTREACH_DAILY_SEND_LIMIT` (25) enforced. | Don't block on DNS; don't burn a new domain with volume. |

Hackathon tickets (TDM-162..167, plus human setup TDM-168; all depend only on done work plus keys): 15.1a Context.dev + AgentMail + GitHub spike · 15.2a sourcing + import · 15.3a scout claim brief · 15.5a writer + CLI review queue · 15.6a sending with limits and suppression (polling) · 15.8a reply polling, classification and `outreach stats`. The originals 15.1, 15.2, 15.4 are superseded; 15.3, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10 stay for after the hackathon.

### E16. Result quality (section 17; lands before 14.4 and before any public badge)
16.1 sandboxed out-of-process gate · 16.2 subject/scoring bundle split · 16.3 scorer v2 (N/A gates, common workload set, cost per solved task) · 16.4 decision rule + power-based repeats · 16.5 metric plumbing · 16.6 provider-side metering + worker wall clock · 16.7 comparability rules in KitSpec · 16.8 warm-ups + noise · 16.9 preregistration + kit hash + reproducible attestation · 16.10 proof checks v2 · 16.11 report v2 (per-requirement table, verdicts, trust checklist, honest wording) · 16.12 egress allow-list + contamination controls · 16.13 Tandem kit v2 · 16.14 judge panel reliability · 16.15 SWE-smith task mining for generated kits · 16.16 skeptic agent on the test plan.

## 16. Conventions for the swarm

- **Read this file first, then `CLAUDE.md`.** Claim work only from the Tandem board. One ticket per session.
- Work in a git worktree per ticket (`git worktree add ../anybench-wt/<ticket> -b <ticket>`); merge to `main` only with `pnpm -r build && pnpm -r test` passing.
- TypeScript, ESM, Node ≥ 22, pnpm. zod at every boundary. Money in integer micro-USD.
- All our own agent calls go through `packages/naive`. Direct Anthropic/OpenAI keys only for the agent under test.
- Tests never spend money by default: use `FakeProvider` and `FakeNaive`; live tests run only with `NAIVE_LIVE=1`, `STRIPE_LIVE_TEST=1`, `VM_LIVE=1`.
- No secrets in git. Add every new env var to `.env.example`.
- No speed or quality number without a correctness gate.
- Write what you learn about external systems to `docs/findings/`.

## 17. Result quality (E16): make every number defensible

Two independent reviews (measurement and statistics; agent-eval design, 2026-11-07, main @ 27594e5) found that today's pipeline can't yet support a claim like "Tandem beats Claude Code". The products we sell are the verdict and the proof that it's fair, so these rules come before the Tandem benchmark (14.4) and before any public badge.

### 17.1 What's wrong today
- **Scoring.** `score.ts` takes medians over gate-passing trials only, then averages over each contender's own workloads (survivorship bias). One failed gate deletes the total, and "not applicable" gates count as failures. Ratio-to-best scoring reshuffles everyone when a contender is added. `parseTarget` ignores units. The kit designer picks the weights and targets with no calibration; the flagship oracle itself misses its 120 ms target.
- **Statistics.** `stats.ts` has CIs and effect sizes, but only `median` reaches the scorer. At n=5 a distribution-free 95% CI on a median doesn't exist. 3 tasks × 5 repeats detects only differences of about 45–50 pts (repeats cluster by task, so effective n≈3). "11/15 vs 9/15" has Fisher p=0.70. About 30 uncorrected comparisons per report produce about 1.5 false wins.
- **Plumbing.** The runner doesn't wrap `run` in `/usr/bin/time -v` (no `wall_s`). Gate metrics aren't in MetricSchema (no `api_p95_ms`). The template reads `peak_rss_kb` while the collector emits `peak_rss_bytes`. Warm-ups run in separate forks that warm nothing. Noise is sampled once and never used.
- **Integrity.** Hidden tests run in-process with contender code (it can patch `node:assert`, stub `fetch`, or append `pass` lines to the writable results file). The gates may ship to the subject computer. Network limits aren't enforced. Cost is self-reported from a file the agent can write.
- **Fairness.** Tandem gets an 8M token cap against 5M for the others. Models are unpinned and Claude Code installs `@latest`. The LLM reviewer's help goes only to the subject. Contender order never rotates. 429s aren't excluded.
- **Task design.** Three small, fully specified tasks in genres models know well, so `tests-pass` saturates and noise decides the ranking. todo-api hands every contender a 5-way ticket split, which is the planner's job. bug-hunt is implement-to-spec with an invented commit history.

### 17.2 Rules (enforced in code, not by convention)
1. **Correctness first, always.** Speed, cost and quality are reported only alongside the pass rate. Cost is **all spend ÷ solved tasks**, and time-to-solve counts failures at the cap. A contender that fails a workload never ranks above an equally fast one that solves it.
2. **Every comparison has a verdict:** `better | worse | indistinguishable`.
   - Pass rates: Newcombe CI on the difference.
   - Continuous metrics: Mann–Whitney exact p<0.05 and |Cliff's δ| ≥ 0.33, with a Hodges–Lehmann CI.
   - Holm correction across the report's comparisons.
   - Agent tasks bootstrap over tasks, not trials.
   - Without significance the report says "no detectable difference at n=…, smallest detectable difference=…".
3. **Sample sizes come from a power estimate shown on the test plan.** Defaults:
   - Software: 5 repeats, each a hyperfine run of ≥10 iterations.
   - Agents: ≥10 repeats per cell (floor 4).
   - An agent "beats" claim needs ≥20 tasks stratified by shape and difficulty, or the claim is downgraded to "on these N tasks".
4. **Comparable setups or no comparison.** `KitSpecSchema` refuses a kit unless:
   - model ids and CLI/harness versions are pinned (`latest`/`main` are resolved to a version or SHA at env build);
   - caps are equal, unless the cap is the `vary` axis or `unequal_caps_reason` is set;
   - every assist (reviewer, tools) goes to every contender or to none.
   The order of contenders rotates per round from a seed.
5. **The agent under test can't touch the measurement.**
   - Separate subject and scoring bundles: `gates/`, `reference/`, `proof/oracle/` and the rubric never reach the subject computer, and answers never live under `workloads/`.
   - Hidden tests run out of process, as a separate uid with read-only tests, against a sandboxed contender.
   - Cost comes from the provider side, and wall time from the worker.
   - Egress is allowed only to the model API, and logged.
6. **Preregistered.** The whole-kit hash, weights, primary metric and repeats are frozen before the first contender trial. Every later edit is logged with a reason, and attest refuses a mismatched hash otherwise. The kit designer's repair loop never sees contender scores.
7. **Headline = per-requirement table, not a composite.** Each row shows median, CI, effect, n, pass-rate CI and pass^k, plus the verdict.
   - A composite 0–100 is shown only with its breakdown, a ±50% weight-sensitivity band, rank stability and the verdict with reviewed quality weighted at 0.
   - Badges show "better" only when rule 2 says so.
8. **LLM-judged quality is optional and audited.**
   - ≥3 judges from ≥2 model families, none from the subject's family.
   - Identity scrubbed (`CLAUDE.md`, `.claude/`, `.tandem/`, trailers, formatter).
   - Binary per-criterion checks; pairs judged in both orders; quoted `path:line` checked mechanically.
   - A calibration set of 30 human-labelled diffs and Krippendorff α ≥ 0.667.
   - It's kept out of the headline when α fails, >5% of quotes fail, or the gap is within judge noise.
9. **The proof suite proves the gate discriminates, not just that it runs:**
   - the oracle passes;
   - partial oracles (one feature removed) fail;
   - a mutation kill rate ≥90%, with survivors listed;
   - deterministic planted regressions;
   - an A-vs-A null run (the noise floor);
   - a cheater contender scores 0;
   - the gate gives the same result 3 times;
   - every hidden assertion traces to `instruction.md`;
   - a known ordering holds (a weaker model in the same harness ranks lower).
10. **Honest wording.** Never claim "beats", "faster" or "cheaper" without rule 2. Never use human minutes from a simulated approver ("simulated approvals: N, latency"), call synthetic tasks "from your history", report speed or cost from failed trials, or show a composite without its breakdown.

### 17.3 Trust checklist (rendered on every report and published page)
- Preregistered kit hash and every post-result edit.
- Exact models, versions, configs and caps; who chose the contenders; which were dropped and why.
- Task count, provenance, held-out share and difficulty bands.
- Per-task pass counts with Wilson CIs, plus pass^k.
- Cost per solved task and time-to-solve with failures, and where the metering came from.
- Weights and who set them; CIs on differences; rank stability; the verdict at reviewed weight 0.
- Judges, α, calibration and identity scrubbing.
- Proof results: mutation kill rate, cheater suite, null run.
- Gates never on the subject computer; egress logged; exploit flags; discarded trials with reasons.
- Real or simulated approver.
- Signed.

### 17.4 Metrics by subject class (required core is gated; vanity metrics are never a headline)
| Class | Required core | Optional | Never a headline |
|---|---|---|---|
| Agent / harness | pass@1, pass^k; cost per solved task; time-to-solve (failures at cap); interventions | audited quality, regressions (PASS_TO_PASS), merge conflicts, speedup vs 1 worker | raw tokens, turns, claims, lines of code |
| Chat / http agent | success on labelled answers; cost per conversation; p95 latency | policy violations | tone |
| CLI | warm and cold wall time; peak RSS | startup | user CPU alone |
| Service | p50/p95/p99 at fixed open-loop rates; max RPS within SLO; error rate | cold start | peak RPS with errors |
| Library | ops/s at realistic sizes; allocations | p99 | microbenchmarks on trivial input |
| Terminal | throughput with a reference-grid match; memory per scrollback | input latency | bytes/s without a match |
| Web app | LCP/INP/CLS on a throttled profile; TTFB p95 | bundle size | Lighthouse score alone |

Sources: Miller 2024 (arXiv 2411.00640), Hesterberg (arXiv 1411.5279), SWE-bench/SWE-smith, METR HCAST (arXiv 2503.17354) and its reward-hacking report, Terminal-Bench 2.0, the ABC checklist (arXiv 2507.02825), Zheng 2023 (arXiv 2306.05685), Panickssery 2024 (arXiv 2404.13076).
