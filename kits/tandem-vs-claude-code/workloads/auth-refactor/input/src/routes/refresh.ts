import type { ServerResponse } from "node:http";
import { HttpError, sendJson } from "../http.ts";
import type { SessionStore } from "../sessions.ts";
import type { AuthContext } from "../types.ts";

/** POST /auth/refresh → 200 { expiresAt }, slides the session expiry forward. */
export function refresh(res: ServerResponse, ctx: AuthContext, deps: { sessions: SessionStore }): void {
  const session = deps.sessions.touch(ctx.sessionId);
  if (session === undefined) throw new HttpError(401, "unauthorized", "session is gone");
  sendJson(res, 200, { expiresAt: new Date(session.expiresAt).toISOString() });
}
