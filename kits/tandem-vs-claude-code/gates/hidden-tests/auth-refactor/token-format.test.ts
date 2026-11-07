import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { SECRET, alice, bob, decodePart, startApp } from "./helpers.ts";

test("login returns an HS256 JWT and expiresIn", async (t) => {
  const api = await startApp(t);
  const { token, expiresIn } = await alice(api);
  const parts = token.split(".");
  assert.equal(parts.length, 3, "a JWT has three dot-separated parts");
  for (const p of parts) assert.match(p, /^[A-Za-z0-9_-]+$/, "parts are unpadded base64url");
  assert.deepEqual(decodePart(parts[0]!), { alg: "HS256", typ: "JWT" });
  assert.equal(expiresIn, 900, "TOKEN_TTL_S defaults to 900");
});

test("the signature is HMAC-SHA256 over header.payload with JWT_SECRET", async (t) => {
  const api = await startApp(t);
  const { token } = await bob(api);
  const [h, p, s] = token.split(".") as [string, string, string];
  const expected = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  assert.equal(s, expected);
});

test("claims carry sub, role, iat, exp = iat + TOKEN_TTL_S and a unique jti", async (t) => {
  const api = await startApp(t, { TOKEN_TTL_S: "120" });
  const first = await alice(api);
  const second = await alice(api);
  const claims = decodePart(first.token.split(".")[1]!);
  assert.equal(claims.sub, "u_alice");
  assert.equal(claims.role, "admin");
  assert.ok(Number.isInteger(claims.iat) && Math.abs(claims.iat - Date.now() / 1000) < 30, "iat is now, in seconds");
  assert.equal(claims.exp, claims.iat + 120);
  assert.equal(first.expiresIn, 120);
  assert.equal(typeof claims.jti, "string");
  assert.notEqual(claims.jti, decodePart(second.token.split(".")[1]!).jti, "each token gets its own jti");
});

test("sessions are gone: login sets no cookie and a sid cookie is not accepted", async (t) => {
  const api = await startApp(t);
  const { res } = await bob(api);
  assert.equal(res.headers.get("set-cookie"), null, "login must not set a cookie any more");
  const viaCookie = await api.call("GET", "/me", { cookie: "sid=anything.at-all" });
  assert.equal(viaCookie.status, 401);
});

test("jwt.ts exports signJwt and verifyJwt with typed errors", async () => {
  const { signJwt, verifyJwt } = (await import("../src/jwt.ts")) as {
    signJwt: (payload: Record<string, unknown>, secret: string) => string;
    verifyJwt: (token: string, secret: string, nowS?: number) => Record<string, unknown>;
  };
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({ sub: "u_x", role: "user", iat: now, exp: now + 60, jti: "j1" }, "k");
  assert.equal(verifyJwt(token, "k").sub, "u_x");
  assert.throws(() => verifyJwt(token, "other-key"), (e: any) => e.code === "invalid_token");
  assert.throws(() => verifyJwt(token, "k", now + 61), (e: any) => e.code === "token_expired");
  assert.throws(() => verifyJwt("not.a.jwt", "k"), (e: any) => e.code === "invalid_token");
  assert.throws(() => verifyJwt("garbage", "k"), (e: any) => e.code === "invalid_token");
});
