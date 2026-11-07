# todo-api

A todo REST API on plain `node:http`. No runtime dependencies, no build step: Node 22.18+ runs the
TypeScript files directly (type stripping), so only erasable syntax is allowed (no `enum`, no
parameter properties, no `namespace`). Import local files with their `.ts` extension.

```sh
npm start        # PORT=3000 by default
npm test         # node --test "test/**/*.test.ts"
```

## Layout

| File | What it does |
| --- | --- |
| `src/main.ts` | Starts the server on `PORT`. |
| `src/app.ts` | `createApp(options)`: builds the `http.Server` and its routes. Tests import this. |
| `src/router.ts` | A tiny method + path router with `:param` segments. |
| `src/http.ts` | JSON helpers and the error body shape. |

Only `GET /health` exists today. See the task for the API to build.
