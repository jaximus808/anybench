// TDM-72 test helpers: event factories, tenants, and a test app with a header authenticator.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AnybenchEvent, RunState } from "@anybench/core";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDb, type Database, type DbHandle } from "../../src/db/client.js";
import { runs, users } from "../../src/db/schema/index.js";
import type { EventFanout } from "../../src/lib/events.js";
import type { AppDeps } from "../../src/types.js";
import { recordingSentryTdm14, silentLoggerTdm14 } from "./server-tdm14.js";

export function messageEventTdm72(
  runId: string | null,
  i: number,
  text = `message ${i}`,
): AnybenchEvent {
  return {
    run_id: runId,
    seq: 0,
    type: "agent.message",
    source: "agent_session",
    source_id: "agent-session-1",
    severity: "info",
    actor: { kind: "worker", id: "worker-1" },
    cost_delta_micro_usd: 0n,
    at: new Date().toISOString(),
    payload: {
      agent_role: "designer",
      naive_seq: i,
      message_role: "assistant",
      text,
      truncated: false,
    },
  };
}

export function stateChangedEventTdm72(runId: string, from: RunState, to: RunState): AnybenchEvent {
  return {
    run_id: runId,
    seq: 0,
    type: "run.state_changed",
    source: "run",
    source_id: runId,
    severity: "info",
    actor: { kind: "system" },
    cost_delta_micro_usd: 0n,
    at: new Date().toISOString(),
    payload: { from, to },
  };
}

let githubIdTdm72 = 72_000;

export async function seedRunTdm72(db: Database, login: string, state: RunState = "running") {
  const [u] = await db
    .insert(users)
    .values({ githubLogin: `${login}-${githubIdTdm72}`, githubId: githubIdTdm72++ })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({ ownerId: u!.id, question: `is ${login} faster?`, budgetMicroUsd: 5_000_000n, state })
    .returning();
  return { userId: u!.id, runId: run!.id };
}

/** An app whose authenticator reads `Authorization: Bearer <user id>`. */
export function eventsAppTdm72(
  url: string,
  extra: Record<string, string> = {},
  eventFanout?: EventFanout,
): { app: ReturnType<typeof createApp>; dbh: DbHandle; deps: AppDeps } {
  const config = loadConfig({
    DATABASE_URL: url,
    DATABASE_URL_DIRECT: url,
    LOG_LEVEL: "silent",
    EVENTS_POLL_INTERVAL_MS: "50",
    ...extra,
  });
  const dbh = createDb(url, { max: 4 });
  const deps: AppDeps = {
    config,
    logger: silentLoggerTdm14(),
    db: dbh.db,
    sentry: recordingSentryTdm14(),
    authenticate: async (req) => {
      const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
      return m ? { kind: "user", userId: m[1]! } : null;
    },
    ...(eventFanout ? { eventFanout } : {}),
  };
  return { app: createApp(deps), dbh, deps };
}

const WRITER = fileURLToPath(new URL("../fixtures/tdm72-event-writer.ts", import.meta.url));

/** Run the writer fixture in a separate Node process (the "worker"). Resolves on exit 0. */
export function writeEventsInChildTdm72(url: string, runId: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WRITER, url, runId, String(count)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`)),
    );
  });
}
