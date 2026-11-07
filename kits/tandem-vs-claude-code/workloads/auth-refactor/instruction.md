# Task: move auth from server-side sessions to JWT

The repository in your working directory is `auth-service` (read its `README.md`). Logins create
a server-side session held in memory and send a `sid` cookie. That breaks as soon as we run more
than one instance, so we are moving to stateless JSON Web Tokens. The session code is threaded
through config, the auth middleware, the `AuthContext` type and every auth route, so expect to touch
most of `src/`.

## Ground rules

- No new dependencies. Implement HS256 yourself with `node:crypto` (`createHmac`, `timingSafeEqual`).
- `src/app.ts` keeps exporting `createApp(options?: { env?: Record<string, string | undefined> })`,
  returning an `http.Server` that is not listening yet. Config comes from `options.env`
  (default `process.env`).
- Node runs the `.ts` files directly (type stripping): erasable TypeScript only, `.ts` import extensions.
- Remove the session store and cookie handling entirely. Update the tests under `test/` to the new
  scheme (`npm test` must pass).

## Contract

Errors keep the existing body: `{ "error": { "code": "<code>", "message": "<text>" } }`.

### Config

| Env | Meaning |
| --- | --- |
| `JWT_SECRET` | HMAC key. Required: `createApp` throws when it is missing or empty. |
| `TOKEN_TTL_S` | Token lifetime in seconds, default `900`. |

`SESSION_SECRET` and `SESSION_TTL_S` go away.

### Tokens

- Format: a standard JWT, `base64url(header).base64url(payload).base64url(signature)`, unpadded.
- Header is exactly `{ "alg": "HS256", "typ": "JWT" }`. Signature is HMAC-SHA256 of
  `header.payload` with `JWT_SECRET`.
- Payload: `{ sub: <user id>, role: "admin" | "user", iat: <now, seconds>, exp: iat + TOKEN_TTL_S, jti: <random unique id> }`.
- `src/jwt.ts` exports:
  - `signJwt(payload: object, secret: string): string`
  - `verifyJwt(token: string, secret: string, nowS?: number): Claims`, which throws an error whose
    `code` is `"invalid_token"` (malformed, bad signature, any `alg` other than `HS256`) or
    `"token_expired"` (`exp <= nowS`).

### Routes

| Route | Auth | Success | Errors |
| --- | --- | --- | --- |
| `POST /auth/login` `{ username, password }` | none | `200 { token, expiresIn }` and **no** `Set-Cookie` | `401 invalid_credentials` |
| `GET /me` | bearer | `200 { id, username, role }` | see below |
| `GET /admin/users` | bearer, role `admin` | `200 { users: [{ id, username, role }] }` | `403 forbidden` for non-admins |
| `POST /auth/logout` | bearer | `204`; the token's `jti` is revoked | |
| `POST /auth/refresh` | bearer | `200 { token, expiresIn }`: a new token with a new `jti`; the old token is revoked | |

Protected routes read `Authorization: Bearer <token>` only. Cookies are ignored. Auth failures are
`401` with one of these codes:

| Code | When |
| --- | --- |
| `unauthorized` | no bearer token at all |
| `invalid_token` | malformed, bad signature, wrong secret, wrong `alg` (including `none`) |
| `token_expired` | valid signature but `exp` has passed |
| `token_revoked` | the `jti` was logged out or refreshed away |

Revocation may live in memory per instance (a denylist of `jti` until its `exp`). Everything else
must be stateless: a token issued by one instance is accepted by any other instance with the same
`JWT_SECRET`, and rejected (`invalid_token`) by an instance with a different one.

Done means the routes behave as written, no session or cookie code is left, and `npm test` passes.
