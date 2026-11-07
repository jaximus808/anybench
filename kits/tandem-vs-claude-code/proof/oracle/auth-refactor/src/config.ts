export interface Config {
  /** HMAC-SHA256 key for signing tokens. */
  jwtSecret: string;
  /** Token lifetime in seconds. */
  tokenTtlS: number;
}

export type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const jwtSecret = env.JWT_SECRET ?? "";
  if (jwtSecret === "") throw new Error("JWT_SECRET is required");
  const ttl = Number(env.TOKEN_TTL_S ?? 900);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("TOKEN_TTL_S must be a positive integer");
  return { jwtSecret, tokenTtlS: ttl };
}
