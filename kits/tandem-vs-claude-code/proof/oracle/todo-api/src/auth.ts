import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { HttpError, readJson, sendJson } from "./http.ts";
import type { Router } from "./router.ts";
import type { Store, User } from "./store.ts";
import { asObject, invalidBody, requireString } from "./validate.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || saltHex === undefined || hashHex === undefined) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** The user behind `Authorization: Bearer <token>`, or 401 unauthorized. */
export function requireUser(req: IncomingMessage, store: Store): string {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  const userId = match === null ? undefined : store.userIdForToken(match[1]!);
  if (userId === undefined) throw new HttpError(401, "unauthorized", "a valid bearer token is required");
  return userId;
}

function publicUser(user: User): { id: string; email: string } {
  return { id: user.id, email: user.email };
}

export function addAuthRoutes(router: Router, store: Store): void {
  router.add("POST", "/auth/register", async ({ req, res }) => {
    const body = asObject(await readJson(req));
    const email = requireString(body, "email").trim();
    const password = requireString(body, "password");
    if (!email.includes("@")) throw invalidBody("email must be an email address");
    if (password.length < 8) throw invalidBody("password must be at least 8 characters");
    if (store.findUserByEmail(email) !== undefined) {
      throw new HttpError(409, "email_taken", "an account with this email already exists");
    }
    const user = store.addUser(email, await hashPassword(password));
    sendJson(res, 201, publicUser(user));
  });

  router.add("POST", "/auth/login", async ({ req, res }) => {
    const body = asObject(await readJson(req));
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = store.findUserByEmail(email);
    if (user === undefined || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, "invalid_credentials", "email or password is wrong");
    }
    const token = randomBytes(24).toString("base64url");
    store.addToken(token, user.id);
    sendJson(res, 200, { token });
  });
}
