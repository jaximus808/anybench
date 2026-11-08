// TDM-67 test helpers: an app with a Bearer-<user id> authenticator, a recording job queue and an
// optional billing gate, plus seeding for users, runs in a given state, and proven kits.
import { readFileSync } from "node:fs";
import { PROOF_CHECKS, type ApiKeyScope, type KitSpec, type RunState } from "@anybench/core";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDb, type Database, type DbHandle } from "../../src/db/client.js";
import { apiKeys, kits, runs, users } from "../../src/db/schema/index.js";
import {
  apiKeyDisplayPrefix,
  hashApiKey,
  newApiKeySecret,
  resolveApiKey,
} from "../../src/lib/auth-key.js";
import type { BillingGate } from "../../src/lib/billing-gate.js";
import type { JobQueue } from "../../src/lib/job-queue.js";
import type { AppDeps } from "../../src/types.js";
import { recordingSentryTdm14, silentLoggerTdm14 } from "./server-tdm14.js";

export function kitSpecTdm67(): KitSpec {
  const url = new URL("../fixtures/tdm67-kit-software-cli.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as KitSpec;
}

export interface RecordedJobTdm67 {
  task: string;
  payload: Record<string, unknown>;
  jobKey: string;
}

export function recordingJobsTdm67(): JobQueue & { jobs: RecordedJobTdm67[] } {
  const jobs: RecordedJobTdm67[] = [];
  return {
    jobs,
    async add(_tx, task, payload, options) {
      jobs.push({ task, payload, jobKey: options.jobKey });
    },
  };
}

export interface RunsAppTdm67 {
  app: ReturnType<typeof createApp>;
  dbh: DbHandle;
  jobs: ReturnType<typeof recordingJobsTdm67>;
  gateCalls: { userId: string; estimate: bigint }[];
}

/** `Authorization: Bearer <user id>` authenticates. `billingGate` omitted = the default stub. */
export function runsAppTdm67(
  url: string,
  options: {
    env?: Record<string, string>;
    billingGate?: BillingGate;
    /** Extra deps (e.g. a fake trace store). */
    deps?: Partial<AppDeps>;
  } = {},
): RunsAppTdm67 {
  const config = loadConfig({
    DATABASE_URL: url,
    DATABASE_URL_DIRECT: url,
    LOG_LEVEL: "silent",
    PUBLIC_WEB_URL: "https://anybench.jaxonp.com",
    ALLOWED_ORIGINS: "https://anybench.jaxonp.com",
    ...options.env,
  });
  const dbh = createDb(url, { max: 4 });
  const jobs = recordingJobsTdm67();
  const gateCalls: RunsAppTdm67["gateCalls"] = [];
  const deps: AppDeps = {
    config,
    logger: silentLoggerTdm14(),
    db: dbh.db,
    sentry: recordingSentryTdm14(),
    // `Bearer ab_…` is a real API key (TDM-66); any other Bearer value is taken as a user id.
    authenticate: async (req) => {
      const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
      if (!m) return null;
      if (m[1]!.startsWith("ab_")) return resolveApiKey({ db: dbh.db, config }, m[1]!);
      return { kind: "user", userId: m[1]! };
    },
    jobs,
    ...options.deps,
  };
  if (options.billingGate) {
    const inner = options.billingGate;
    deps.billingGate = async (actor, estimate) => {
      gateCalls.push({ userId: actor.userId, estimate });
      return inner(actor, estimate);
    };
  }
  return { app: createApp(deps), dbh, jobs, gateCalls };
}

let githubIdTdm67 = 67_000;

export async function seedUserTdm67(db: Database, login: string): Promise<string> {
  const n = githubIdTdm67++;
  const [u] = await db
    .insert(users)
    .values({ githubLogin: `${login}-${n}`, githubId: n })
    .returning({ id: users.id });
  return u!.id;
}

/** Move a run (as the system) to `state`, optionally with an estimate. */
export async function forceRunStateTdm67(
  db: Database,
  runId: string,
  state: RunState,
  estimateMicroUsd?: bigint,
): Promise<void> {
  await db
    .update(runs)
    .set({ state, ...(estimateMicroUsd !== undefined ? { estimateMicroUsd } : {}) })
    .where(eq(runs.id, runId));
}

/** Give a run a kit version whose six proof checks all passed (or not), and point the run at it. */
export async function seedKitTdm67(db: Database, runId: string, proven: boolean): Promise<string> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const proof = PROOF_CHECKS.map((check, i) => ({
    check,
    pass: proven || i > 0,
    reason: "seeded",
    evidence: [],
  }));
  const [kit] = await db
    .insert(kits)
    .values({
      ownerId: run!.ownerId,
      runId,
      version: 1,
      spec: kitSpecTdm67(),
      proof,
      hash: "a".repeat(64),
    })
    .returning({ id: kits.id });
  await db.update(runs).set({ kitId: kit!.id }).where(eq(runs.id, runId));
  return kit!.id;
}

/** Insert an API key for `userId` and return its secret (as TDM-66 stores it: hash only). */
export async function seedApiKeyTdm67(
  db: Database,
  userId: string,
  scopes: ApiKeyScope[],
  runIds: string[] | null = null,
): Promise<string> {
  const secret = newApiKeySecret("test");
  await db.insert(apiKeys).values({
    ownerId: userId,
    name: "tdm67",
    prefix: apiKeyDisplayPrefix(secret),
    hash: hashApiKey(secret),
    scopes,
    runIds,
  });
  return secret;
}
