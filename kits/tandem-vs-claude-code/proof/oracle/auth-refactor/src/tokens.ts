import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { signJwt } from "./jwt.ts";
import type { Claims, Role } from "./types.ts";

export interface IssuedToken {
  token: string;
  expiresIn: number;
}

/** Issues tokens and remembers revoked `jti`s until they would have expired anyway. */
export class TokenService {
  private readonly revoked = new Map<string, number>();
  private readonly config: Config;
  private readonly now: () => number;

  constructor(config: Config, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.config = config;
    this.now = now;
  }

  issue(userId: string, role: Role): IssuedToken {
    const iat = this.now();
    const claims: Claims = { sub: userId, role, iat, exp: iat + this.config.tokenTtlS, jti: randomUUID() };
    return { token: signJwt(claims, this.config.jwtSecret), expiresIn: this.config.tokenTtlS };
  }

  revoke(jti: string, exp: number): void {
    this.sweep();
    this.revoked.set(jti, exp);
  }

  isRevoked(jti: string): boolean {
    return this.revoked.has(jti);
  }

  private sweep(): void {
    const now = this.now();
    for (const [jti, exp] of this.revoked) if (exp <= now) this.revoked.delete(jti);
  }
}
