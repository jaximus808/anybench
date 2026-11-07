# auth-service

Login, profile and admin endpoints on plain `node:http`, with server-side sessions in memory and a
`sid` cookie. No runtime dependencies, no build step: Node 22.18+ runs the TypeScript directly
(type stripping), so only erasable syntax is allowed and local imports keep their `.ts` extension.

```sh
SESSION_SECRET=dev npm start   # PORT=3000
npm test
```

## Layout

| File | What it does |
| --- | --- |
| `src/main.ts` | Starts the server. |
| `src/app.ts` | `createApp({ env })`: wires config, stores and routes into an `http.Server`. |
| `src/config.ts` | Reads settings from the env. |
| `src/types.ts` | `AuthContext`, the identity every protected route receives. |
| `src/users.ts` | Seeded user store and scrypt password checks. |
| `src/sessions.ts` | In-memory session store keyed by session id. |
| `src/http.ts` | JSON, cookie and error helpers. |
| `src/middleware/auth.ts` | Turns a request into an `AuthContext` (or a 401). |
| `src/routes/*.ts` | `login`, `logout`, `refresh`, `me`, `admin`. |

Seeded users: `alice` / `wonderland` (role `admin`), `bob` / `builder123` (role `user`).
