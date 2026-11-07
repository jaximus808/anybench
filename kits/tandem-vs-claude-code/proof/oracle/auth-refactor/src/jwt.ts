import { createHmac, timingSafeEqual } from "node:crypto";
import type { Claims } from "./types.ts";

export type JwtErrorCode = "invalid_token" | "token_expired";

export class JwtError extends Error {
  readonly code: JwtErrorCode;
  constructor(code: JwtErrorCode, message: string) {
    super(message);
    this.name = "JwtError";
    this.code = code;
  }
}

const HEADER = { alg: "HS256", typ: "JWT" } as const;

function b64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mac(input: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

function decode(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new JwtError("invalid_token", "token is not base64url");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new JwtError("invalid_token", "token part is not JSON");
  }
}

export function signJwt(payload: object, secret: string): string {
  const head = `${b64(HEADER)}.${b64(payload)}`;
  return `${head}.${mac(head, secret).toString("base64url")}`;
}

/** Verifies an HS256 token and returns its claims. Throws JwtError. */
export function verifyJwt(token: string, secret: string, nowS = Math.floor(Date.now() / 1000)): Claims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("invalid_token", "token must have three parts");
  const [h, p, s] = parts as [string, string, string];
  const header = decode(h) as { alg?: unknown; typ?: unknown };
  if (header.alg !== "HS256") throw new JwtError("invalid_token", "only HS256 is accepted");
  const expected = mac(`${h}.${p}`, secret);
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new JwtError("invalid_token", "bad signature");
  }
  const claims = decode(p) as Partial<Claims>;
  if (
    typeof claims.sub !== "string" ||
    (claims.role !== "admin" && claims.role !== "user") ||
    typeof claims.exp !== "number" ||
    typeof claims.iat !== "number" ||
    typeof claims.jti !== "string"
  ) {
    throw new JwtError("invalid_token", "claims are incomplete");
  }
  if (claims.exp <= nowS) throw new JwtError("token_expired", "token has expired");
  return claims as Claims;
}
