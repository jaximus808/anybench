import type { IncomingMessage } from "node:http";
import type { Config } from "../config.ts";
import { HttpError } from "../http.ts";
import { JwtError, verifyJwt } from "../jwt.ts";
import type { TokenService } from "../tokens.ts";
import type { AuthContext, Role } from "../types.ts";

export interface AuthDeps {
  config: Config;
  tokens: TokenService;
}

/** The caller's identity from `Authorization: Bearer <jwt>`, or a 401 with the reason. */
export function authenticate(req: IncomingMessage, deps: AuthDeps): AuthContext {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthorized", "a bearer token is required");
  }
  let claims;
  try {
    claims = verifyJwt(header.slice("Bearer ".length).trim(), deps.config.jwtSecret);
  } catch (err) {
    if (err instanceof JwtError) throw new HttpError(401, err.code, err.message);
    throw err;
  }
  if (deps.tokens.isRevoked(claims.jti)) throw new HttpError(401, "token_revoked", "token was revoked");
  return { userId: claims.sub, role: claims.role, tokenId: claims.jti, expiresAt: claims.exp };
}

export function requireRole(ctx: AuthContext, role: Role): void {
  if (ctx.role !== role) throw new HttpError(403, "forbidden", `requires role ${role}`);
}
