# auth-service

Login, profile and admin endpoints on plain `node:http`, with stateless HS256 JWT bearer tokens (`src/jwt.ts`).
No runtime dependencies, no build step: Node 22.18+ runs the TypeScript directly
(type stripping), so only erasable syntax is allowed and local imports keep their `.ts` extension.

```sh
JWT_SECRET=dev npm start   # PORT=3000
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
| `src/jwt.ts` | HS256 sign and verify. |
| `src/tokens.ts` | Issues tokens and keeps the per-instance revocation list. |
| `src/http.ts` | JSON, cookie and error helpers. |
| `src/middleware/auth.ts` | Verifies the bearer token into an `AuthContext` (or a 401). |
| `src/routes/*.ts` | `login`, `logout`, `refresh`, `me`, `admin`. |

Seeded users: `alice` / `wonderland` (role `admin`), `bob` / `builder123` (role `user`).
