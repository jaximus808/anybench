import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJson, sendJson } from "../http.ts";
import type { TokenService } from "../tokens.ts";
import type { UserStore } from "../users.ts";

export interface LoginDeps {
  tokens: TokenService;
  users: UserStore;
}

/** POST /auth/login { username, password } → 200 { token, expiresIn } */
export async function login(req: IncomingMessage, res: ServerResponse, deps: LoginDeps): Promise<void> {
  const body = await readJson(req);
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const user = deps.users.check(username, password);
  if (user === undefined) throw new HttpError(401, "invalid_credentials", "username or password is wrong");
  sendJson(res, 200, deps.tokens.issue(user.id, user.role));
}
