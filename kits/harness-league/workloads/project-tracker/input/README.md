# project-tracker

A multi-user project tracker API (teams, projects, boards, cards, comments) on plain `node:http`.
No runtime dependencies, no build step: Node 22.18+ runs the TypeScript files directly (type
stripping), so only erasable syntax is allowed (no `enum`, no parameter properties, no
`namespace`). Import local files with their `.ts` extension.

```sh
npm start        # PORT=3000 by default, DATA_FILE=<path> to persist
npm test         # node --test "test/**/*.test.ts"
```

## Layout

| File | What it does |
| --- | --- |
| `src/main.ts` | Starts the server on `PORT`. |
| `src/app.ts` | `createApp(options)`: builds the `http.Server` and its routes. Tests import this. `AppOptions` documents every option. |
| `src/router.ts` | A tiny method + path router with `:param` segments. |
| `src/http.ts` | JSON helpers and the error body shape. |
| `fixtures/tracker-v1.json` | A data file written by tracker 1.x (format version 1). The new version must migrate it. |

Only `GET /health` exists today. See the task for the API to build.
