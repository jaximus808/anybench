# Naïve platform: hosting facts (from the live docs, 2026-11-07)

Source: read of https://usenaive.ai/docs/sdk/typescript and linked pages (sdk/{apps,deployments,computers,keys,credits,domains}, api/{apps,authentication,database,deployments}, computer/{limits-and-billing,sandbox,networking}, platform/pricing, llms.txt). vetta.sh/docs/* 301s to usenaive.ai/docs/*. Not yet verified by running calls: that is TDM-170 [2.9].

## Computers
- `client.computers.create({name?, vcpu?, memory_mb?, disk_gb?})`: vCPU 1–16, memory 128–65536 MiB (default 2 vCPU / 4 GiB), disk up to 100 GiB. No named sizes.
- Price: vCPU $0.000014/s ($0.0504/h), memory $0.0000045/GiB-s ($0.0162/GiB-h). Per 10-min block: $0.0084 per vCPU + $0.0027 per GiB. Disk not metered, no creation fee. Billed in advance per 10-min block.
- **Max lifetime: 12 h wall-clock from create, then auto-destroyed.** Snapshots survive a destroy.
- **No inbound networking** ("a sandbox reaches out; nothing reaches in"; `POST /v1/computers/{id}/expose` → 404). A computer cannot serve public HTTP. No persistent volumes.
- Unfunded → paused, not destroyed. Idle auto-pause is documented only for agent-owned computers.
- Background processes surviving between exec calls: not stated (TDM-170 tests it).
- Always-on cost estimate, 1 vCPU / 1 GiB: $0.0666/h ≈ $1.60/day ≈ $48/month.

## Apps (`client.apps`)
- `apps.deploy(id, files, content_hash?)` → `POST /v1/apps/{id}/deployments`, files = path → base64, async build (queued → building → ready | error). Runtime, language, serverless vs long-lived, max request duration and SSE support: **not stated**.
- Secrets write-only (`POST /v1/apps/{id}/secrets`, names A-Z0-9_); `DATABASE_*` and `VETTA_MCP_TOKEN` platform-managed.
- Fullstack apps get managed Postgres (env `DATABASE_*`, 30 s statement timeout, REST as service role so no RLS).
- `mcp: "/mcp"` mints `VETTA_MCP_TOKEN` (app must require `Authorization: Bearer`); agents see the app's tools as `<app>.<tool>`, limited by the apps tool's `allowed_apps`. An unreachable endpoint adds no tools and doesn't fail a turn.
- Custom domains: `client.domains.create({name, kind, receive?})` → `domains.records(id)` → `domains.verify(id)` → `apps.connectDomain(appId, domainId)` (pending → connected). No app-hosting price published.

## Deployments (`client.deployments`)
- Cron-scheduled agent runs (each fire = a normal session from `input_template`), not an always-on process. Min interval 5 min. `budget_micro_usd` required per run. Methods: create, run, pause, resume, runs, update, delete.

## API keys
- `client.keys.create({name, scopes})` → `POST /v1/api_keys` (caller needs `admin`; secret shown once; prefix `sk_live_`; modes test | live).
- Scopes: `agents:read`, `agents:write`, `sessions:read`, `sessions:write`, `computers:write`, `proxy:write`, `files:read`, `files:write`, `billing:read`, `billing:write`, `webhooks:*`, `audit:read`, `admin`. No `apps:*` (app routes use `agents:*`); no `computers:read` (inspect and command history need `computers:write`).
- Our current key fails `GET /v1/credits/balance` with 403 "missing the `billing:read` scope" (observed 2026-11-07). The plan is active (no 402).

## Gate
- Every non-billing route returns `402 subscription_required` without an active plan (Standard $20/mo, Pro $200/mo, 7-day trial).

## Consequences for Anybench
- Worker on Naïve must **hand itself off before 12 h**: graphile-worker keeps all state in Postgres and is safe with concurrent workers (SKIP LOCKED), so at ~11 h the running worker creates a successor computer from the worker snapshot, waits for its heartbeat row, then drains and exits. Fallback supervisor: a Naïve deployment (cron ≥ 5 min) that respawns the worker if its heartbeat goes stale (costs one session per fire).
- API cannot be a Naïve computer (no inbound). Candidate: a Naïve fullstack app if TDM-170 shows long-lived requests/SSE work; else Vercel Functions (TDM-154).
- Serving Anybench's MCP as a Naïve app `mcp` endpoint gives our own Naïve agents Anybench tools natively.
