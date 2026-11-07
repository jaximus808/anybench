import type { ServerResponse } from "node:http";
import type { Config } from "../config.ts";
import { clearCookie, sendEmpty } from "../http.ts";
import type { SessionStore } from "../sessions.ts";
import type { AuthContext } from "../types.ts";

/** POST /auth/logout → 204, destroys the session and clears the cookie. */
export function logout(res: ServerResponse, ctx: AuthContext, deps: { config: Config; sessions: SessionStore }): void {
  deps.sessions.destroy(ctx.sessionId);
  sendEmpty(res, 204, { "set-cookie": clearCookie(deps.config.cookieName) });
}
