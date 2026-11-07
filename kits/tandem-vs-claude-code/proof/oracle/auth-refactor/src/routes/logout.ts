import type { ServerResponse } from "node:http";
import { sendEmpty } from "../http.ts";
import type { TokenService } from "../tokens.ts";
import type { AuthContext } from "../types.ts";

/** POST /auth/logout → 204, revokes the caller's token. */
export function logout(res: ServerResponse, ctx: AuthContext, deps: { tokens: TokenService }): void {
  deps.tokens.revoke(ctx.tokenId, ctx.expiresAt);
  sendEmpty(res, 204);
}
