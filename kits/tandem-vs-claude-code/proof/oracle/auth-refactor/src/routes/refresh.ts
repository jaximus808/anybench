import type { ServerResponse } from "node:http";
import { sendJson } from "../http.ts";
import type { TokenService } from "../tokens.ts";
import type { AuthContext } from "../types.ts";

/** POST /auth/refresh → 200 { token, expiresIn }: rotates the token and revokes the old one. */
export function refresh(res: ServerResponse, ctx: AuthContext, deps: { tokens: TokenService }): void {
  const next = deps.tokens.issue(ctx.userId, ctx.role);
  deps.tokens.revoke(ctx.tokenId, ctx.expiresAt);
  sendJson(res, 200, next);
}
