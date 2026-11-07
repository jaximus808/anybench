import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";
import type { Role } from "./types.ts";

export interface Session {
  id: string;
  userId: string;
  role: Role;
  expiresAt: number;
}

/**
 * Server-side sessions in memory. The cookie carries `<id>.<hmac(id)>`; the session itself
 * (user, role, expiry) lives only in this process.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly config: Config;
  private readonly now: () => number;

  constructor(config: Config, now: () => number = () => Date.now()) {
    this.config = config;
    this.now = now;
  }

  create(userId: string, role: Role): { session: Session; cookieValue: string } {
    const id = randomBytes(18).toString("base64url");
    const session: Session = { id, userId, role, expiresAt: this.now() + this.config.sessionTtlS * 1000 };
    this.sessions.set(id, session);
    return { session, cookieValue: `${id}.${this.sign(id)}` };
  }

  /** The live session for a cookie value, or undefined (unknown, forged or expired). */
  fromCookie(value: string): Session | undefined {
    const [id, mac] = value.split(".");
    if (id === undefined || mac === undefined) return undefined;
    const expected = Buffer.from(this.sign(id));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  /** Slides the expiry forward. */
  touch(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    session.expiresAt = this.now() + this.config.sessionTtlS * 1000;
    return session;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  private sign(id: string): string {
    return createHmac("sha256", this.config.sessionSecret).update(id).digest("base64url");
  }
}
