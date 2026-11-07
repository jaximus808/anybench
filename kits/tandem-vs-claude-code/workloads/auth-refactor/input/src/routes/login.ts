import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.ts";
import { HttpError, readJson, sendJson, sessionCookie } from "../http.ts";
import type { SessionStore } from "../sessions.ts";
import { publicUser, type UserStore } from "../users.ts";

export interface LoginDeps {
  config: Config;
  sessions: SessionStore;
  users: UserStore;
}

/** POST /auth/login { username, password } → 200 { user } + Set-Cookie sid */
export async function login(req: IncomingMessage, res: ServerResponse, deps: LoginDeps): Promise<void> {
  const body = await readJson(req);
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const user = deps.users.check(username, password);
  if (user === undefined) throw new HttpError(401, "invalid_credentials", "username or password is wrong");
  const { cookieValue } = deps.sessions.create(user.id, user.role);
  sendJson(res, 200, { user: publicUser(user) }, {
    "set-cookie": sessionCookie(deps.config.cookieName, cookieValue, deps.config.sessionTtlS),
  });
}
