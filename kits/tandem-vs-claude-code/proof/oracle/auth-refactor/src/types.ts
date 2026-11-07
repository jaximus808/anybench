export type Role = "admin" | "user";

/** What a token says about its holder. */
export interface Claims {
  sub: string;
  role: Role;
  iat: number;
  exp: number;
  jti: string;
}

/** Who is calling. Built by `middleware/auth.ts` from a verified token. */
export interface AuthContext {
  userId: string;
  role: Role;
  /** The token's `jti`, so logout and refresh can revoke it. */
  tokenId: string;
  /** The token's `exp`, in seconds. */
  expiresAt: number;
}
