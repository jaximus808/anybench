// Run suggest (New run screen, contract core apiRoutes.runs.suggest). Mounted at /runs.
//   POST /runs/suggest   read a GitHub repo and propose questions, alternatives and options
//
// The one API route that runs an agent inline: a single bounded Naïve session (lib/suggest.ts,
// ~$0.05 cap, 30 s deadline) whose output only pre-fills a form the user then edits. It creates
// nothing and bills the user nothing. Signed-in users only (session cookie; API keys get 403),
// rate-limited per user. Any failure is a 503 `unavailable`, and the screen falls back to manual
// entry without saying so.
import { apiRoutes } from "@anybench/core";
import { Hono } from "hono";
import { bodyLimitOf, fail, parseOrFail, send, type ActorEnv } from "../lib/api-route.js";
import { requireSessionActor } from "../lib/auth-key.js";
import { SuggestUnavailableError, type RateLimiter, type RunSuggester } from "../lib/suggest.js";
import type { AppDeps } from "../types.js";

const route = apiRoutes.runs.suggest;

export function suggestRoutes(
  deps: AppDeps & { suggester: RunSuggester | null; suggestLimiter: RateLimiter },
): Hono<ActorEnv> {
  const r = new Hono<ActorEnv>();
  r.post("/suggest", bodyLimitOf(4 * 1024), requireSessionActor(deps), async (c) => {
    const actor = c.get("actor");
    if (!deps.suggestLimiter.take(actor.userId))
      return fail(c, "rate_limited", "too many suggestions; wait a few minutes");
    const parsed = await parseOrFail(c, route);
    if (!parsed.ok) return parsed.response;
    if (!deps.suggester) return fail(c, "unavailable", "suggestions are not configured");
    const { source } = parsed.request.body;
    const log = c.get("log");
    try {
      const out = await deps.suggester.suggest({
        github: source.github,
        ref: source.ref,
        userId: actor.userId,
      });
      log.info(
        { suggest: { session: out.sessionId, cost_micro_usd: out.costMicroUsd.toString() } },
        "run suggest done",
      );
      return send(c, route, { suggestion: out.suggestion, cost_micro_usd: out.costMicroUsd });
    } catch (err) {
      const reason = err instanceof SuggestUnavailableError ? err.reason : "agent_failed";
      log.warn({ suggest: { reason }, err }, "run suggest unavailable");
      return fail(c, "unavailable", "suggestions are unavailable right now");
    }
  });
  return r;
}
