export interface Config {
  /** Signs the session cookie value so it cannot be guessed or forged. */
  sessionSecret: string;
  /** Idle lifetime of a session, in seconds. */
  sessionTtlS: number;
  cookieName: string;
}

export type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const sessionSecret = env.SESSION_SECRET ?? "dev-session-secret";
  const ttl = Number(env.SESSION_TTL_S ?? 3600);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("SESSION_TTL_S must be a positive integer");
  return { sessionSecret, sessionTtlS: ttl, cookieName: "sid" };
}
