import type { IncomingMessage } from "node:http";
import type { Config } from "../config.ts";
import { HttpError, parseCookies } from "../http.ts";
import type { SessionStore } from "../sessions.ts";
import type { AuthContext, Role } from "../types.ts";

export interface AuthDeps {
  config: Config;
  sessions: SessionStore;
}

/** The caller's identity from the session cookie, or 401 unauthorized. */
export function authenticate(req: IncomingMessage, deps: AuthDeps): AuthContext {
  const cookie = parseCookies(req.headers.cookie)[deps.config.cookieName];
  const session = cookie === undefined ? undefined : deps.sessions.fromCookie(cookie);
  if (session === undefined) throw new HttpError(401, "unauthorized", "log in first");
  return { userId: session.userId, role: session.role, sessionId: session.id };
}

export function requireRole(ctx: AuthContext, role: Role): void {
  if (ctx.role !== role) throw new HttpError(403, "forbidden", `requires role ${role}`);
}
