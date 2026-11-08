// Deploy the API as a Naïve fullstack app (TDM-154). Idempotent; re-run it any time:
//
//   pnpm tsx scripts/deploy/api.ts [--dry-run] [--skip-build] [--skip-migrate] [--no-verify]
//
// Steps: read .env (never printed) → build the server and its workspace deps → bundle
// apps/server/dist/entry-naive.js into api/app.js → run migrations on DATABASE_URL_DIRECT from
// this machine → find or create the app → write the app secrets whose value changed → deploy
// when the bundle changed, else redeploy when a secret changed (secrets reach the runtime only on
// a new deployment) → wait for `ready` → check /health, the OAuth start redirect and CORS live.
//
// Safety: BILLING_MODE must be test or live (live needs every STRIPE_LIVE_* set); the Neon URLs must not be the prod
// branch's; secrets go to Naïve only through the write-only secrets API, never on argv or in a log.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUsd } from "@anybench/core";
import {
  createNaiveApps,
  createNaiveClientFromEnv,
  showCredits,
  type NaiveApp,
  type NaiveAppDeployment,
  type NaiveAppsApi,
} from "@anybench/naive";
import { bundleApi } from "./lib/bundle.js";
import {
  diffSecrets,
  findEnvFile,
  parseDeployEnv,
  planSecrets,
  readEnvFile,
  secretValueHash,
  type DeployEnv,
  type SecretPlan,
} from "./lib/api-plan.js";
import { checkHealth, checkOAuthRedirect, checkPreflight, type Check } from "./lib/verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const args = new Set(process.argv.slice(2));
const flag = (name: string) => args.has(`--${name}`);
for (const a of args) {
  if (!["--dry-run", "--skip-build", "--skip-migrate", "--no-verify"].includes(a)) {
    throw new Error(`unknown argument ${a}`);
  }
}

const say = (step: string, data?: Record<string, unknown>) =>
  console.log(`[deploy:api] ${step}${data ? ` ${JSON.stringify(data)}` : ""}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildWorkspace(): void {
  say("build", { cmd: "pnpm -r --workspace-concurrency=2 --filter server... build" });
  // process.env never holds the .env values (they stay in `raw` below), so nothing leaks here.
  const r = spawnSync(
    "pnpm",
    ["-r", "--workspace-concurrency=2", "--filter", "server...", "build"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (r.status !== 0) throw new Error(`build failed (exit ${r.status})`);
}

async function waitForApp(apps: NaiveAppsApi, id: string): Promise<NaiveApp> {
  for (let i = 0; i < 60; i++) {
    const app = await apps.get(id);
    if (app.status === "active") return app;
    if (app.status === "error")
      throw new Error(`app ${id} is in error: ${app.error ?? "no detail"}`);
    await sleep(5_000);
  }
  throw new Error(`app ${id} still provisioning after 5 min`);
}

async function waitForDeployment(
  apps: NaiveAppsApi,
  appId: string,
  deploymentId: string,
): Promise<NaiveAppDeployment> {
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    const d = (await apps.deployments(appId, 10)).find((x) => x.id === deploymentId);
    if (d?.status === "ready") {
      say("deployment ready", { id: d.id, after_s: Math.round((Date.now() - t0) / 1000) });
      return d;
    }
    if (d?.status === "error")
      throw new Error(`deployment ${deploymentId} failed: ${d.error ?? "no detail"}`);
    await sleep(3_000);
  }
  throw new Error(`deployment ${deploymentId} not ready after 6 min`);
}

/** Write changed secrets, delete ones we no longer want. Returns whether anything changed. */
async function syncSecrets(apps: NaiveAppsApi, appId: string, plan: SecretPlan): Promise<boolean> {
  const have = await apps.secrets(appId);
  const diff = diffSecrets(plan.secrets, have);
  for (const name of diff.set) {
    const value = plan.secrets[name]!;
    const hash = secretValueHash(name, value);
    const res = await apps.setSecret(appId, name, value, hash);
    if (res.value_hash !== hash)
      say("warning: value_hash not echoed; re-runs will rewrite", { name });
  }
  for (const name of diff.remove) await apps.deleteSecret(appId, name);
  say("secrets", { set: diff.set, removed: diff.remove, unchanged: diff.unchanged.length });
  return diff.set.length + diff.remove.length > 0;
}

async function fetchRetry(url: string, init: RequestInit, tries = 10): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if (res.status !== 404 && res.status < 500) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await sleep(3_000);
  }
  throw new Error(`${url}: ${String((last as Error)?.message ?? last)}`);
}

async function verify(base: string, env: DeployEnv, plan: SecretPlan): Promise<Check[]> {
  const checks: Check[] = [];
  const t0 = Date.now();
  const h = await fetchRetry(`${base}/health`, {});
  const health = checkHealth(h.status, await h.json().catch(() => null));
  health.detail.ms = Date.now() - t0;
  checks.push(health);

  const o = await fetchRetry(`${base}/auth/github?redirect_to=%2F`, { redirect: "manual" });
  checks.push(
    checkOAuthRedirect(o.status, o.headers.get("location"), {
      clientId: env.GITHUB_CLIENT_ID,
      callbackUrl: plan.callbackUrl,
    }),
  );
  const cookie = o.headers.get("set-cookie") ?? "";
  checks.at(-1)!.detail.state_cookie = cookie
    .split(";")
    .slice(1)
    .map((s) => s.trim())
    .join("; ");

  const webOrigin = new URL(env.DEPLOY_API_WEB_URL).origin;
  const p = await fetchRetry(`${base}/auth/me`, {
    method: "OPTIONS",
    headers: {
      Origin: webOrigin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  checks.push(checkPreflight(p.status, p.headers, webOrigin));
  return checks;
}

async function main(): Promise<void> {
  const envFile = findEnvFile(repoRoot, process.env.ANYBENCH_ENV_FILE);
  const env = parseDeployEnv(readEnvFile(envFile));
  say("env", {
    file: envFile,
    app: env.DEPLOY_API_APP_NAME,
    web: env.DEPLOY_API_WEB_URL,
    billing: env.BILLING_MODE,
  });

  if (!flag("skip-build")) buildWorkspace();
  // Imported after the build: a fresh checkout has no apps/server/dist yet.
  const server = await import("server");
  const { naiveVercelJson } = server;
  const bundle = await bundleApi({
    entry: join(repoRoot, "apps/server/dist/entry-naive.js"),
    vercelJson: naiveVercelJson(300),
  });
  for (const w of bundle.warnings) say("warning", { bundle: w });
  say("bundle", {
    bytes: Object.fromEntries(Object.entries(bundle.files).map(([k, v]) => [k, v.length])),
    dependencies: bundle.dependencies,
    contentHash: bundle.contentHash,
  });

  if (flag("dry-run")) {
    const plan = planSecrets(env, env.DEPLOY_API_PUBLIC_URL ?? "https://example.vercel.app");
    say("dry run: would set", {
      secrets: Object.keys(plan.secrets),
      sameSite: plan.sameSite,
      origins: plan.allowedOrigins,
    });
    return;
  }

  if (!flag("skip-migrate")) {
    const host = new URL(env.DATABASE_URL_DIRECT).hostname;
    say("migrate", { host });
    await server.db.runMigrations(env.DATABASE_URL_DIRECT);
    say("migrate done");
  }

  const naiveOpts = { NAIVE_API_KEY: env.NAIVE_API_KEY, NAIVE_BASE_URL: env.NAIVE_BASE_URL };
  const client = createNaiveClientFromEnv(naiveOpts);
  const apps = createNaiveApps({
    apiKey: env.NAIVE_API_KEY,
    ...(env.NAIVE_BASE_URL ? { baseUrl: env.NAIVE_BASE_URL } : {}),
  });
  const before = await showCredits(client).catch(() => undefined);
  if (before)
    say("credits before", {
      balance: formatUsd(before.balanceMicroUsd, { decimals: 4 }),
      micro_usd: String(before.balanceMicroUsd),
    });

  let app = await apps.findByName(env.DEPLOY_API_APP_NAME);
  if (!app) {
    app = await apps.create({
      name: env.DEPLOY_API_APP_NAME,
      type: "fullstack",
      description:
        "Anybench API (Hono, apps/server entry-naive.ts). Managed by scripts/deploy/api.ts",
    });
    say("app created", { id: app.id });
  }
  if (app.type !== "fullstack") throw new Error(`app ${app.name} is ${app.type}, not fullstack`);
  app = await waitForApp(apps, app.id);
  say("app", { id: app.id, url: app.url, status: app.status });

  const publicUrlOf = (a: NaiveApp) =>
    env.DEPLOY_API_PUBLIC_URL ??
    (a.url ? (a.url.startsWith("http") ? a.url : `https://${a.url}`) : undefined);
  let publicUrl = publicUrlOf(app);
  const secretsChanged = publicUrl
    ? await syncSecrets(apps, app.id, planSecrets(env, publicUrl))
    : false;

  const latest = (await apps.deployments(app.id, 10))[0];
  let current: NaiveAppDeployment | undefined;
  if (!latest || latest.content_hash !== bundle.contentHash || latest.status === "error") {
    const files = Object.fromEntries(
      Object.entries(bundle.files).map(([k, v]) => [k, v.toString("base64")]),
    );
    const d = await apps.deploy(app.id, files, bundle.contentHash);
    say("deploy", { id: d.id, status: d.status });
    current = await waitForDeployment(apps, app.id, d.id);
  } else if (secretsChanged) {
    const d = await apps.redeploy(app.id, latest.id);
    say("redeploy (secrets changed)", { id: d.id, from: latest.id });
    current = await waitForDeployment(apps, app.id, d.id);
  } else {
    current = latest.status === "ready" ? latest : await waitForDeployment(apps, app.id, latest.id);
    say("unchanged", { deployment: current.id });
  }

  if (!publicUrl) {
    // First deploy: the app URL exists only now. Write the URL-dependent secrets and redeploy.
    app = await apps.get(app.id);
    publicUrl = publicUrlOf(app);
    if (!publicUrl) throw new Error("app has no URL after its first deployment");
    if (await syncSecrets(apps, app.id, planSecrets(env, publicUrl))) {
      const d = await apps.redeploy(app.id, current.id);
      say("redeploy (first secrets)", { id: d.id });
      current = await waitForDeployment(apps, app.id, d.id);
    }
  }
  const plan = planSecrets(env, publicUrl);
  say("live", {
    url: publicUrl,
    deployment: current.id,
    oauth_callback: plan.callbackUrl,
    sameSite: plan.sameSite,
  });

  let failed = false;
  if (!flag("no-verify")) {
    for (const c of await verify(plan.baseUrl, env, plan)) {
      say(`check ${c.name}: ${c.ok ? "ok" : "FAILED"}`, c.detail);
      failed ||= !c.ok;
    }
  }
  const after = await showCredits(client).catch(() => undefined);
  if (before && after) {
    const spent = before.balanceMicroUsd - after.balanceMicroUsd;
    say("credits after", {
      balance: formatUsd(after.balanceMicroUsd, { decimals: 4 }),
      spent_micro_usd: String(spent),
    });
  }
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  // Messages here come from our own validation or Naïve error codes; neither carries a value.
  console.error(`[deploy:api] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
