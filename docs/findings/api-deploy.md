# API deploy: apps/server as a Naïve fullstack app (TDM-154, 2026-11-08)

The API (the Hono `createApp`, unchanged) runs as a Naïve `fullstack` app, which is a Vercel project in Naïve's team (see `naive-hosting.md`, section 2). This first deploy uses the **Neon dev branch** and **BILLING_MODE=test**.

| | |
|---|---|
| Live URL | **https://anybench-api-sj1arspaf10q.vercel.app** |
| Naïve app | `anybench-api`, `app_gppnm385c8txebwf1ttsnpmrd3`, type `fullstack`, no `mcp` path yet |
| GitHub OAuth callback | **https://anybench-api-sj1arspaf10q.vercel.app/auth/github/callback** |
| OAuth start (the web app links here) | `GET /auth/github?redirect_to=/<path>` (not `/auth/github/start`) |
| Database | Neon dev branch, `ep-little-cell-bfqb3tom` (aws **us-west-2**), pooled URL for queries |
| Region | function in `iad1` (`x-vercel-id: sfo1::iad1::…`) |
| Cost | **$0 measured**: the balance was 250,881,852 µ$ before and after two full runs (2 builds + 1 redeploy, about 20 requests) |

## How to deploy (idempotent)

```sh
pnpm tsx scripts/deploy/api.ts            # build, bundle, migrate dev, sync secrets, deploy if changed, verify
pnpm tsx scripts/deploy/api.ts --dry-run  # bundle and list the secret names, no network writes
#   --skip-build  --skip-migrate  --no-verify
```

What it does, in order:

1. Reads `.env` into a local object. It never goes into `process.env`, argv or a log. From a git worktree it falls back to the main checkout's `.env`; `ANYBENCH_ENV_FILE` overrides the path. zod validates the keys it needs and reports every problem at once. It **refuses `BILLING_MODE` other than `test`**, a non-test Stripe key, and a `DATABASE_URL(_DIRECT)` that points at the `_PROD` branch.
2. Runs `pnpm -r --workspace-concurrency=2 --filter server... build`, then bundles `apps/server/dist/entry-naive.js` with esbuild into `api/app.js`. Workspace `@anybench/*` code is inlined from `dist/`. npm packages stay external and go into the shipped `package.json` at the exact version this checkout resolves, so Vercel installs them. The other files are `vercel.json` (rewrite all paths to `/api/app?__path=/$1`, `maxDuration: 300`) and `package.json` (`engines.node: 22.x`).
3. Runs migrations from this machine on `DATABASE_URL_DIRECT` (dev), never from the app.
4. Finds the app by name, or creates it.
5. Diffs the app's secrets by `value_hash`. The script sends `v1:sha256("anybench-deploy\n<name>\n<value>")` with each `setSecret`. Naïve stores that hash as given and returns it from `secrets`, so the script writes only names whose value changed and deletes names it owns but no longer wants.
6. Deploys when the bundle's `content_hash` differs from the newest deployment's. Otherwise it **redeploys** when a secret changed, because secrets reach the runtime only on a new deployment. On the very first run the app URL exists only after the first deployment, so the script then writes the URL-dependent secrets and redeploys once.
7. Checks the live app: `/health` (200 with `db.ok`), the OAuth start redirect (302 to GitHub with the right `client_id` and `redirect_uri`, plus a state), and a credentialed CORS preflight from the web origin. It exits 1 if any check fails.

### App secrets it sets

`NODE_ENV=production`, `ANYBENCH_ENV=staging`, `LOG_LEVEL`, `ANYBENCH_DATABASE_URL`, `ANYBENCH_DATABASE_URL_DIRECT`, `BILLING_MODE=test`, `STRIPE_SECRET_KEY` (from `STRIPE_TEST_SECRET_KEY`), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL` (derived from the app URL), `SESSION_SECRET`, `SESSION_COOKIE_SAMESITE`, `ALLOWED_ORIGINS`, `PUBLIC_WEB_URL`, `ADMIN_GITHUB_LOGINS`, `RUNNER_TOKEN_SECRET`, `EVENTS_STREAM_MODE=poll`, `EVENTS_STREAM_MAX_DURATION_MS=240000`, `EVENTS_POLL_INTERVAL_MS=1000`, and `S3_*`. `SESSION_COOKIE_DOMAIN` is set only on the custom domains.

- **The platform owns every `DATABASE_*` name** on a fullstack app (they point at the app's managed Postgres). Our Neon URLs therefore travel as `ANYBENCH_DATABASE_URL(_DIRECT)`. `entry-naive.ts` maps them onto `DATABASE_URL(_DIRECT)` before `loadConfig`, and it refuses to boot (503) without them rather than fall back to the platform database.
- Deploy settings live in `.env`: `DEPLOY_API_APP_NAME`, `DEPLOY_API_WEB_URL` (default `https://anybench.vercel.app`), `DEPLOY_API_EXTRA_ORIGINS` (default `https://anybench.jaxonp.com`) and `DEPLOY_API_PUBLIC_URL`.

## Run 1: first deploy (2026-11-08T02:40Z)

```
$ pnpm tsx scripts/deploy/api.ts --skip-build
[deploy:api] env {"file":"…/anybench/.env","app":"anybench-api","web":"https://anybench.vercel.app","billing":"test"}
[deploy:api] bundle {"bytes":{"api/app.js":299150,"package.json":443,"vercel.json":177},"dependencies":{"@aws-sdk/client-s3":"3.1164.0",
  "@aws-sdk/s3-request-presigner":"3.1164.0","@hono/node-server":"2.1.6","@sentry/node":"11.11.0","@usenaive-sdk/managed-agents":"0.12.3",
  "drizzle-orm":"0.45.4","hono":"4.13.17","pg":"8.23.1","pino":"10.4.0","zod":"4.6.7"},"contentHash":"sha256:8a5d309c…"}
[deploy:api] migrate {"host":"ep-little-cell-bfqb3tom.c-5.us-west-2.aws.neon.tech"}
[deploy:api] migrate done
[deploy:api] credits before {"balance":"$250.8819","micro_usd":"250881852"}
[deploy:api] app created {"id":"app_gppnm385c8txebwf1ttsnpmrd3"}
[deploy:api] app {"id":"app_gppnm385c8txebwf1ttsnpmrd3","url":null,"status":"active"}
[deploy:api] deploy {"id":"apd_1pjjsrp6sx3na23rsc342p5vtg","status":"building"}
[deploy:api] deployment ready {"id":"apd_1pjjsrp6sx3na23rsc342p5vtg","after_s":27}
[deploy:api] secrets {"set":[24 names],"removed":[],"unchanged":0}
[deploy:api] redeploy (first secrets) {"id":"apd_q759w3npwwzb3gp8ad2v4qf8fn"}
[deploy:api] deployment ready {"id":"apd_q759w3npwwzb3gp8ad2v4qf8fn","after_s":30}
[deploy:api] live {"url":"https://anybench-api-sj1arspaf10q.vercel.app","oauth_callback":"https://anybench-api-sj1arspaf10q.vercel.app/auth/github/callback","sameSite":"none"}
[deploy:api] check health: ok {"status":200,"ok":true,"env":"staging","db":{"ok":true,"latencyMs":479},"ms":641}
[deploy:api] check oauth start: ok {"status":302,"location":"https://github.com/login/oauth/authorize","client_id":"Ov23liFUBaucJ4ggyxjy",
  "redirect_uri":"https://anybench-api-sj1arspaf10q.vercel.app/auth/github/callback","state":"present","scope":"read:user user:email",
  "state_cookie":"Max-Age=600; Path=/auth/github; HttpOnly; Secure; SameSite=Lax"}
[deploy:api] check cors preflight: ok {"status":204,"access-control-allow-origin":"https://anybench.vercel.app","access-control-allow-credentials":"true"}
[deploy:api] credits after {"balance":"$250.8819","spent_micro_usd":"0"}
```

- The first deployment went from `building` to `ready` in 27 s, and the redeploy in 30 s. Vercel runs `npm install` on the shipped `package.json` (including `@aws-sdk/client-s3` and `@sentry/node`), which is why this is slower than the spike's 6–13 s.
- `setSecret` echoed our `value_hash`, so idempotency by hash works.
- The bundle worked on the first deploy, with no ESM or CJS problems. There is no build-log API, so a broken bundle would show only as `status: error` with `error`.

## Run 2: re-run with nothing changed (idempotency)

```
[deploy:api] app {"id":"app_gppnm385c8txebwf1ttsnpmrd3","url":"https://anybench-api-sj1arspaf10q.vercel.app","status":"active"}
[deploy:api] secrets {"set":[],"removed":[],"unchanged":24}
[deploy:api] unchanged {"deployment":"apd_q759w3npwwzb3gp8ad2v4qf8fn"}
[deploy:api] check health: ok {"status":200,…,"db":{"ok":true,"latencyMs":428},"ms":698}
[deploy:api] check oauth start: ok {…}
[deploy:api] check cors preflight: ok {…}
[deploy:api] credits after {"balance":"$250.8819","spent_micro_usd":"0"}
```

## Run 3: after rebasing on main (bundle changed, secrets did not)

```
[deploy:api] secrets {"set":[],"removed":[],"unchanged":24}
[deploy:api] deploy {"id":"apd_1mmyqm7e40dkcp916a3xxdd1bv","status":"building"}
[deploy:api] deployment ready {"id":"apd_1mmyqm7e40dkcp916a3xxdd1bv","after_s":30}
[deploy:api] check health: ok {"status":200,"ok":true,"env":"staging","db":{"ok":true,"latencyMs":436},"ms":2451}
[deploy:api] check oauth start: ok · check cors preflight: ok
[deploy:api] credits after {"balance":"$250.8819","spent_micro_usd":"0"}
```

The first request after a new deployment took 2.45 s end to end: cold instance, npm-installed dependencies loading, and a new TLS connection to Neon.

## Live checks with curl (02:42Z)

```
$ B=https://anybench-api-sj1arspaf10q.vercel.app
$ for i in 1 2 3; do curl -s -o /dev/null -w "GET /health -> %{http_code} in %{time_total}s\n" $B/health; done
GET /health -> 200 in 0.609108s
GET /health -> 200 in 0.191295s
GET /health -> 200 in 0.190907s
$ curl -s $B/health
{"ok":true,"env":"staging","paused":false,"uptimeSec":25,"db":{"ok":true,"latencyMs":62}}

$ curl -s -D - -o /dev/null "$B/auth/github?redirect_to=%2Fruns"
HTTP/2 302
location: https://github.com/login/oauth/authorize?client_id=Ov23liFUBaucJ4ggyxjy&redirect_uri=https%3A%2F%2Fanybench-api-sj1arspaf10q.vercel.app%2Fauth%2Fgithub%2Fcallback&scope=read%3Auser+user%3Aemail&state=<nonce>&allow_signup=true
server: Vercel
set-cookie: anybench_oauth_state=<signed>; Max-Age=600; Path=/auth/github; HttpOnly; Secure; SameSite=Lax
x-vercel-id: sfo1::iad1::k5gnx-…

$ curl -s -i -H "Origin: https://anybench.vercel.app" $B/auth/me
HTTP/2 401
access-control-allow-credentials: true
access-control-allow-origin: https://anybench.vercel.app
access-control-expose-headers: X-Request-Id, Retry-After
vary: Origin
{"error":{"code":"unauthorized","message":"sign in required","request_id":"…"}}

$ curl -s -i -X OPTIONS -H "Origin: https://evil.example" -H "Access-Control-Request-Method: GET" $B/auth/me
HTTP/2 403                                                   (no CORS headers)

$ curl -s -i "$B/auth/github/callback?code=x&state=y"
HTTP/2 400  {"error":{"code":"bad_request","message":"sign-in state is missing, expired or does not match; start again",…}}

$ curl -s -i "$B/auth/github/callback?error=access_denied"
HTTP/2 302  location: https://anybench.vercel.app/?auth_error=access_denied
```

- A warm request takes about 190 ms end to end from California. `select 1` takes about 62 ms warm and 430–480 ms on a new connection, because the dev branch is in **us-west-2** while the function runs in **iad1**. (`naive-hosting.md` assumed that Neon and the function share a region. That holds for plan.md's `aws-us-east-1` prod project, but not for this dev branch.)
- The full sign-in round trip (GitHub login → callback → session cookie → `/auth/me` from the web) was **not** exercised. It waits on the founder setting the callback below in the GitHub OAuth app.

## Cookies and the web origin

The web app is at `https://anybench.vercel.app`, and the API is at `https://anybench-api-sj1arspaf10q.vercel.app`. `vercel.app` is on the Public Suffix List, so these are **two different sites**:

- A `SameSite=Lax` session cookie would not ride the web app's `fetch(…, {credentials: "include"})`. The deploy therefore sets `SESSION_COOKIE_SAMESITE=none` (new config, default `lax`; `none` requires Secure). CSRF protection is unchanged: it is the Origin allowlist check.
- No `Domain` is possible: a cookie cannot be scoped to a public suffix. The session cookie is host-only on the API host.
- **Browsers that block third-party cookies (Safari by default, Firefox ETP strict, Chrome with 3PC off) will still drop it**, so `/auth/me` from the web app would answer 401 there. Two ways out: (a) the custom domains (`anybench.jaxonp.com` + `api.anybench.jaxonp.com` are same-site; re-running the deploy with them switches to `lax` and `Domain=.anybench.jaxonp.com` automatically), or (b) a Next.js rewrite in apps/web (`/api/:path*` → the API), so that the browser only ever talks to its own origin.
- The OAuth state cookie stays `SameSite=Lax` and host-only on `Path=/auth/github`. GitHub's redirect back to the API is a top-level GET, which Lax cookies ride.

## Founder actions

1. **GitHub OAuth app → Authorization callback URL:** `https://anybench-api-sj1arspaf10q.vercel.app/auth/github/callback`. A GitHub OAuth App has a single callback URL, and `redirect_uri` must sit under it, so this replaces `https://api.anybench.jaxonp.com/auth/github/callback` until the custom domain is live. Alternatively, register a second OAuth app for this host.
2. **Web project env (Vercel `anybench`):** `NEXT_PUBLIC_ANYBENCH_API_URL=https://anybench-api-sj1arspaf10q.vercel.app`, then redeploy the web app (the value is inlined at build time).

## Custom domain api.anybench.jaxonp.com (not done; waits for DNS)

This follows the spike (`naive-hosting.md`, section 3). Naïve returns only email records for a domain, so the hosting record below is the Vercel default and is **unverified**.

```ts
const dom = await client.domains.create({ name: "api.anybench.jaxonp.com", kind: "external", receive: false });
await client.apps.connectDomain("app_gppnm385c8txebwf1ttsnpmrd3", dom.id);   // → { status: "pending" }
```

1. In Cloud DNS for jaxonp.com, add `CNAME api.anybench → cname.vercel-dns.com.`. If Vercel asks for a `_vercel` TXT challenge, add that too. **Do not publish the `_dmarc` record Naïve lists**: its host is relative to the apex, so it would set DMARC for all of jaxonp.com. The Resend/SES records are needed only if this domain sends mail.
2. Poll `client.apps.domains(appId)` until `status: "connected"` (and `client.domains.verify(dom.id)`).
3. In `.env`, set `DEPLOY_API_PUBLIC_URL=https://api.anybench.jaxonp.com` and, once the web app is on its domain, `DEPLOY_API_WEB_URL=https://anybench.jaxonp.com`. Re-run `pnpm tsx scripts/deploy/api.ts`: it rewrites the callback, sets `SESSION_COOKIE_SAMESITE=lax` and `SESSION_COOKIE_DOMAIN=.anybench.jaxonp.com`, and redeploys.
4. Change the GitHub OAuth callback to `https://api.anybench.jaxonp.com/auth/github/callback`.

## Not covered here

- **MCP:** the app has no `mcp` path yet, because `apps/server` does not serve `/mcp` today. When it does, `apps.update(id, { mcp: "/mcp" })` mints `VETTA_MCP_TOKEN`.
- **SSE:** runs in `poll` mode with `EVENTS_STREAM_MAX_DURATION_MS=240000`, under the platform's 300 s cap. The poll and reconnect behaviour is covered by TDM-72's tests and the TDM-170 live SSE probe; no live run stream was opened here, since that needs a signed-in user and a run.
- **Webhooks:** no webhook routes exist yet. `@hono/node-server` passes a raw body through (it uses `incoming.rawBody` when the host sets it, and the stream otherwise), so signature checks see the exact bytes.
- **Logs:** Naïve has no runtime-log API. The function logs with pino to stdout, and nothing collects that output yet.
- **Pool:** `max: 5` per Fluid instance on the pooled URL. Idle-client errors from Neon are logged instead of crashing the instance (an unhandled pg `error` event would).
