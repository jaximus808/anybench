import type { ServerResponse } from "node:http";
import { HttpError, sendJson } from "../http.ts";
import type { AuthContext } from "../types.ts";
import { publicUser, type UserStore } from "../users.ts";

/** GET /me → 200 { id, username, role } */
export function me(res: ServerResponse, ctx: AuthContext, deps: { users: UserStore }): void {
  const user = deps.users.get(ctx.userId);
  if (user === undefined) throw new HttpError(401, "unauthorized", "user no longer exists");
  sendJson(res, 200, publicUser(user));
}
