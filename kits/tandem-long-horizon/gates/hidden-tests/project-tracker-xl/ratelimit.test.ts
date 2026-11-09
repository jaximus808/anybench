// Area `ratelimit`: instruction.md section 9 (Rate limiting), on a fake clock, and step 3 of 0.3
// (with 3a, API key restrictions, and 3b, idempotency, after it), and the scheduler of 0.9.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, assertStatus, Clock, createApiKey, createCard, eventLog, login, ok, setupBoard, signUp, startApp, startOf, type Res } from "./helpers.ts";

const RL_HEADERS = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"];

function assertNoRateHeaders(res: Res, what: string): void {
  for (const h of RL_HEADERS) assert.equal(res.headers.get(h), null, `${what}: unexpected ${h}`);
}

function assertRate(res: Res, limit: number, remaining: number, reset: number, what = ""): void {
  assert.equal(res.headers.get("x-ratelimit-limit"), String(limit), `${what} x-ratelimit-limit`);
  assert.equal(res.headers.get("x-ratelimit-remaining"), String(remaining), `${what} x-ratelimit-remaining`);
  assert.equal(res.headers.get("x-ratelimit-reset"), String(reset), `${what} x-ratelimit-reset`);
}

test("GET /health answers { ok: true } without auth and carries no rate-limit headers", async (t) => {
  const api = await startApp(t, { rateLimit: { limit: 1, windowMs: 60_000 } });
  for (let i = 0; i < 3; i++) {
    const res = await api.call("GET", "/health");
    assertStatus(res, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(res.body, { ok: true });
    assertNoRateHeaders(res, "GET /health");
  }
});

test("counted requests carry x-ratelimit-limit, -remaining and -reset for the fixed window", async (t) => {
  const clock = new Clock(1_000_000);
  const api = await startApp(t, { now: clock.now, rateLimit: { limit: 5, windowMs: 60_000 }, tokenTtlMs: 10_000_000 });
  const u = await signUp(api);
  assertRate(await api.call("GET", "/me", undefined, u.token), 5, 4, 1020, "1st");
  assertRate(await api.call("POST", "/teams", { name: "T" }, u.token), 5, 3, 1020, "2nd (a write)");
  clock.t = 1_019_999;
  assertRate(await api.call("GET", "/teams", undefined, u.token), 5, 2, 1020, "last ms of the window");
  clock.t = 1_020_000;
  assertRate(await api.call("GET", "/teams", undefined, u.token), 5, 4, 1080, "next window");
  clock.t = 1_020_500;
  const odd = await startApp(t, { now: clock.now, rateLimit: { limit: 3, windowMs: 7_000 }, tokenTtlMs: 10_000_000 });
  const v = await signUp(odd);
  // window start = floor(1020500 / 7000) * 7000 = 1015000, end = 1022000.
  assertRate(await odd.call("GET", "/me", undefined, v.token), 3, 2, 1022, "7 s windows");
});

test("the spec example: limit 2, windowMs 60000, clock at 1000000", async (t) => {
  const clock = new Clock(1_000_000);
  const api = await startApp(t, { now: clock.now, rateLimit: { limit: 2, windowMs: 60_000 }, tokenTtlMs: 10_000_000 });
  const u = await signUp(api);
  const r1 = await api.call("GET", "/me", undefined, u.token);
  assertStatus(r1, 200);
  assertRate(r1, 2, 1, 1020, "request 1");
  const r2 = await api.call("GET", "/me", undefined, u.token);
  assertStatus(r2, 200);
  assertRate(r2, 2, 0, 1020, "request 2");
  const r3 = await api.call("GET", "/me", undefined, u.token);
  assertError(r3, 429, "rate_limited");
  assertRate(r3, 2, 0, 1020, "request 3");
  assert.equal(r3.headers.get("retry-after"), "20");
  clock.t = 1_019_400;
  const r4 = await api.call("GET", "/me", undefined, u.token);
  assertError(r4, 429, "rate_limited");
  assert.equal(r4.headers.get("retry-after"), "1", "ceil(600 / 1000)");
  clock.t = 1_019_999;
  assert.equal((await api.call("GET", "/me", undefined, u.token)).headers.get("retry-after"), "1", "never below 1");
  clock.t = 1_020_000;
  const fresh = await api.call("GET", "/me", undefined, u.token);
  assertStatus(fresh, 200, "a fresh budget");
  assertRate(fresh, 2, 1, 1080);
  assert.equal(fresh.headers.get("retry-after"), null, "only a 429 carries retry-after");
});

test("a 429 has no other effect and is not counted", async (t) => {
  const clock = new Clock(5_000_000);
  const api = await startApp(t, { now: clock.now, rateLimit: { limit: 2, windowMs: 60_000 }, tokenTtlMs: 10_000_000 });
  const u = await signUp(api);
  await ok(api, 201, "POST", "/teams", { name: "Counted" }, u.token);
  await ok(api, 200, "GET", "/me", undefined, u.token);
  for (let i = 0; i < 3; i++) assertError(await api.call("POST", "/teams", { name: "Blocked" }, u.token), 429, "rate_limited");
  assertError(await api.call("POST", "/auth/logout", undefined, u.token), 429, "rate_limited", "logout is rate limited too");
  clock.advance(60_000);
  const teams = await api.call("GET", "/teams", undefined, u.token);
  assertStatus(teams, 200, "the token was not revoked by the blocked logout");
  assert.deepEqual(teams.body.items.map((x: any) => x.name), ["Counted"], "blocked writes did nothing");
  assert.equal(teams.headers.get("x-ratelimit-remaining"), "1", "429s from the old window don't carry over");
  assertStatus(await api.call("GET", "/me", undefined, u.token), 200);
  assertError(await api.call("GET", "/me", undefined, u.token), 429, "rate_limited");
});

test("budgets are per credential: two tokens of the same user count separately, and an API key apart from its owner's tokens", async (t) => {
  const clock = new Clock(2_000_000);
  const api = await startApp(t, { now: clock.now, rateLimit: { limit: 2, windowMs: 60_000 }, tokenTtlMs: 10_000_000 });
  const u = await signUp(api);
  const second = await login(api, u.email, u.password);
  const other = await signUp(api);
  const key = await createApiKey(api, u, { scope: "write" });
  assertRate(await api.call("GET", "/me", undefined, u.token), 2, 0, 2040, "creating the key was the token's first request");
  assertError(await api.call("GET", "/me", undefined, u.token), 429, "rate_limited");
  const b = await api.call("GET", "/me", undefined, second);
  assertStatus(b, 200, "the user's other token has its own budget");
  assertRate(b, 2, 1, 2040);
  const k = await api.call("GET", "/me", undefined, key.secret);
  assertStatus(k, 200, "the API key has its own budget");
  assertRate(k, 2, 1, 2040);
  assertStatus(await api.call("GET", "/teams", undefined, key.secret), 200);
  assertError(await api.call("GET", "/me", undefined, key.secret), 429, "rate_limited", "the key's budget is spent too");
  assertRate(await api.call("GET", "/me", undefined, second), 2, 0, 2040, "and the second token is still independent");
  assertStatus(await api.call("GET", "/me", undefined, other.token), 200, "another user");
});

test("public routes (GET /plans included), unknown routes and 401s carry no rate-limit headers and are not counted", async (t) => {
  const clock = new Clock(3_000_000);
  const api = await startApp(t, { now: clock.now, rateLimit: { limit: 1, windowMs: 60_000 }, tokenTtlMs: 10_000_000 });
  const reg = await api.call("POST", "/auth/register", { email: "r@example.test", password: "password-123", name: "R", handle: "rrr" });
  assertStatus(reg, 201);
  assertNoRateHeaders(reg, "register");
  let token = "";
  for (let i = 0; i < 3; i++) {
    const res = await api.call("POST", "/auth/login", { email: "r@example.test", password: "password-123" });
    assertStatus(res, 200);
    assertNoRateHeaders(res, "login");
    token = res.body.token;
  }
  assertNoRateHeaders(await api.call("POST", "/auth/login", { email: "r@example.test", password: "nope-nope" }), "failed login");
  for (let i = 0; i < 3; i++) {
    const plans = await api.call("GET", "/plans", undefined, token);
    assertStatus(plans, 200, "GET /plans is public");
    assertNoRateHeaders(plans, "GET /plans, even with a token");
  }
  for (let i = 0; i < 3; i++) {
    const unknown = await api.call("GET", "/no/such/route", undefined, token);
    assertError(unknown, 404, "not_found", "unknown route");
    assertNoRateHeaders(unknown, "unknown route");
    const wrongMethod = await api.call("PUT", "/me", { name: "x" }, token);
    assertError(wrongMethod, 404, "not_found", "unlisted method");
    assertNoRateHeaders(wrongMethod, "unlisted method");
    const unauth = await api.call("GET", "/me", undefined, "not-a-real-token-0000000000");
    assertError(unauth, 401, "unauthorized");
    assertNoRateHeaders(unauth, "401");
  }
  const first = await api.call("GET", "/me", undefined, token);
  assertStatus(first, 200, "the token's budget is untouched");
  assertRate(first, 1, 0, 3060);
});

test("the rate limit comes right after authentication: requests refused at 3a, 3b or later are counted, and so is a replay", async (t) => {
  const clock = new Clock(6_000_000);
  const api = await startApp(t, { now: clock.now, rateLimit: { limit: 4, windowMs: 60_000 }, tokenTtlMs: 10_000_000 });
  const u = await signUp(api);
  const key = await createApiKey(api, u, { scope: "read" });
  // The token's budget: create key (1), then four idempotency cases.
  const k1 = await api.call("PATCH", "/me", { name: "x" }, key.secret);
  assertError(k1, 403, "api_key_not_allowed");
  assertRate(k1, 4, 3, 6060, "an api_key_not_allowed is counted");
  const k2 = await api.call("POST", "/teams", { name: "x" }, key.secret);
  assertError(k2, 403, "insufficient_scope");
  assertRate(k2, 4, 2, 6060, "an insufficient_scope is counted");
  const first = await api.call("POST", "/teams", { name: "Once" }, u.token, { idem: "team-1" });
  assertStatus(first, 201);
  assertRate(first, 4, 2, 6060, "the token's second request");
  const replay = await api.call("POST", "/teams", { name: "Once" }, u.token, { idem: "team-1" });
  assertStatus(replay, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assertRate(replay, 4, 1, 6060, "a replay is counted");
  const badHeader = await api.call("POST", "/teams", { name: "Once" }, u.token, { idem: "not ok!" });
  assertError(badHeader, 400, "invalid_header");
  assertRate(badHeader, 4, 0, 6060, "an invalid_header is counted");
  assertError(await api.call("POST", "/teams", { name: "Other" }, u.token, { idem: "team-1" }), 429, "rate_limited", "429 before idempotency_conflict");
  assertStatus(await api.call("GET", "/me", undefined, key.secret), 200);
  assertStatus(await api.call("GET", "/me", undefined, key.secret), 200);
  assertError(await api.call("PATCH", "/me", { name: "x" }, key.secret), 429, "rate_limited", "429 before api_key_not_allowed");
  // Steps 4 to 7 fail after the count; route existence and authentication come before it.
  const v = await signUp(api);
  const r1 = await api.call("GET", "/teams/no-such-team", undefined, v.token);
  assertError(r1, 404, "not_found");
  assertRate(r1, 4, 3, 6060, "a 404 for a path resource is counted");
  const r2 = await api.call("POST", "/teams", {}, v.token);
  assertError(r2, 400, "invalid_body");
  assertRate(r2, 4, 2, 6060, "a 400 is counted");
  const r3 = await api.call("POST", "/teams", undefined, v.token, { raw: "{oops" });
  assertError(r3, 400, "invalid_json");
  assertRate(r3, 4, 1, 6060, "invalid JSON is counted");
  assertStatus(await api.call("GET", "/me", undefined, v.token), 200);
  assertError(await api.call("GET", "/teams/no-such-team", undefined, v.token), 429, "rate_limited", "429 before 404");
  assertError(await api.call("POST", "/teams", undefined, v.token, { raw: "{oops" }), 429, "rate_limited", "429 before invalid_json");
  assertError(await api.call("POST", "/teams", undefined, v.token, { raw: JSON.stringify({ name: "x".repeat(70_000) }) }), 429, "rate_limited", "429 before 413");
  assertError(await api.call("GET", "/nope", undefined, v.token), 404, "not_found", "route existence comes before the rate limit");
  assertError(await api.call("GET", "/me", undefined, "bad-token-00000000000000"), 401, "unauthorized", "authentication comes before the rate limit");
  clock.advance(60_000);
  const teams = await ok(api, 200, "GET", "/teams", undefined, u.token);
  assert.deepEqual(teams.items.map((x: any) => x.name), ["Once"], "one team: the replay and the refused requests created nothing");
});

test("a request answered 429 still runs the scheduler's due jobs first", async (t) => {
  const clock = new Clock(Date.UTC(2026, 2, 1, 12, 0, 0));
  // One window for the whole test, so only the budget decides.
  const api = await startApp(t, { now: clock.now, rateLimit: { limit: 12, windowMs: 10 * 365 * 86_400_000 } });
  const w = await setupBoard(api, clock);
  const log = await eventLog(t, api, w.team.id, w.admin);
  const card = await createCard(api, w.cols[0], w.member, { title: "due", dueDate: "2026-03-02" });
  let last: Res | undefined;
  for (let i = 0; i < 12; i++) {
    last = await api.call("GET", "/me", undefined, w.owner.token);
    if (last.status === 429) break;
  }
  assertError(last!, 429, "rate_limited", "the owner's budget is spent");
  clock.set(startOf("2026-03-02") + 1000);
  const blocked = await api.call("GET", "/me", undefined, w.owner.token);
  assertError(blocked, 429, "rate_limited");
  clock.advance(4000);
  const names = await log.names();
  assert.deepEqual(names, ["card.created", "card.due"]);
  const [, due] = await log.events(2);
  assert.equal(due.data.card.id, card.id);
  assert.equal(due.occurredAt, new Date(startOf("2026-03-02") + 1000).toISOString(), "the job ran on the 429 request");
});
