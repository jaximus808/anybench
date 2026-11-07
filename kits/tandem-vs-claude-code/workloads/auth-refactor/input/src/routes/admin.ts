import type { ServerResponse } from "node:http";
import { sendJson } from "../http.ts";
import { requireRole } from "../middleware/auth.ts";
import type { AuthContext } from "../types.ts";
import { publicUser, type UserStore } from "../users.ts";

/** GET /admin/users → 200 { users } for admins, 403 forbidden otherwise. */
export function listUsers(res: ServerResponse, ctx: AuthContext, deps: { users: UserStore }): void {
  requireRole(ctx, "admin");
  sendJson(res, 200, { users: deps.users.list().map(publicUser) });
}
