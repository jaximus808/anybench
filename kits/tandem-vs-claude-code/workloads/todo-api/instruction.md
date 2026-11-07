# Task: build the todo REST API

The repository in your working directory is a small Node/TypeScript service on plain `node:http`
(read its `README.md`). Today it only answers `GET /health`. Build a todo API with user accounts,
bearer-token auth, persistence and tests, following the contract below exactly. Hidden tests will
call it.

## Ground rules

- No new dependencies. Use Node 22 built-ins only (`node:http`, `node:crypto`, `node:fs`, `node:test`).
- Keep the layout: `src/app.ts` must keep exporting `createApp(options?: { dataFile?: string }): http.Server`.
  It returns a server that is **not** listening yet; callers call `.listen()`. Keep `GET /health`.
- Node runs the `.ts` files directly (type stripping): erasable TypeScript only, `.ts` import extensions.
- Add your own tests under `test/` (`npm test` must pass). Test real behavior over HTTP.

## Contract

All bodies are JSON. Every error answers with the matching status and the body
`{ "error": { "code": "<code>", "message": "<human readable>" } }`.

### Accounts

| Route | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /auth/register` | `{ email, password }` | `201 { id, email }` (never the password) | `400 invalid_body` (email must contain `@`; password at least 8 chars; both required) · `409 email_taken` |
| `POST /auth/login` | `{ email, password }` | `200 { token }` (an opaque string, at least 20 chars) | `401 invalid_credentials` (unknown email or wrong password) |

Store passwords as a salted hash (`crypto.scrypt`), never in plain text.

### Todos (all require `Authorization: Bearer <token>`)

Missing, malformed or unknown token: `401 unauthorized`.

A todo is `{ id: string, title: string, done: boolean, due: string | null, createdAt: string }`.
`due` is an optional `YYYY-MM-DD` date; `createdAt` is an ISO-8601 timestamp.

| Route | Body / query | Success | Errors |
| --- | --- | --- | --- |
| `POST /todos` | `{ title, due? }`, title 1 to 200 chars | `201 <todo>` with `done: false`, `due: null` when omitted | `400 invalid_body` |
| `GET /todos/:id` | | `200 <todo>` | `404 not_found` |
| `PATCH /todos/:id` | `{ title?, done? }` | `200 <todo>` (updated) | `400 invalid_body` · `404 not_found` |
| `DELETE /todos/:id` | | `204` (no body) | `404 not_found` |
| `GET /todos` | `?done=true\|false`, `?limit=1..100` (default 20), `?cursor=` | `200 { items: <todo>[], nextCursor: string \| null }` | `400 invalid_query` |

- A user only ever sees their own todos. Another user's todo id answers `404 not_found` on every route.
- `GET /todos` lists oldest first (creation order). `nextCursor` is opaque; passing it back returns the
  next page with no gaps or repeats; it is `null` on the last page.

### Persistence

When `createApp({ dataFile })` is given a path, users, password hashes and todos are stored in that
JSON file, and a new `createApp({ dataFile })` with the same path sees the same data (users can log in
again and list their todos). Without `dataFile`, keep everything in memory.

### Performance

`GET /todos` and `POST /todos` should stay fast under load: we measure p95 latency at 50 requests/s.
Avoid work per request that grows with the total number of todos in the store.

## Suggested tickets

The work splits into five mostly independent pieces:

1. **Accounts**: `POST /auth/register`, `POST /auth/login`, scrypt hashing, token issue and lookup, a `requireUser` helper.
2. **Todo CRUD**: `POST`, `GET /:id`, `PATCH`, `DELETE`, with per-user ownership.
3. **Listing**: `GET /todos` with the `done` filter and cursor pagination.
4. **Persistence**: the `dataFile` JSON store (atomic writes), loaded on startup.
5. **Tests and validation**: the error body everywhere, input validation, and a test suite under `test/`.

Done means every route above behaves as written and `npm test` passes.
