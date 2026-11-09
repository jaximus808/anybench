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
| `src/http.ts` | JSON helpers, the error body shape, and the raw body reader. |
| `src/validate.ts` | Field validators for request bodies (strings, emails, handles, dates, labels). |
| `src/store.ts` | The in-memory model, creation order, mentions, and the version 2 data file (atomic writes). |
| `src/migrate.ts` | Converts a 1.x data file to the 2.0 model. |
| `src/webhooks.ts` | Background webhook delivery: signing, retries on unref'd timers, timeouts. |
| `fixtures/tracker-v1.json` | A data file written by tracker 1.x (format version 1). The new version must migrate it. |

Every route of the task is implemented (the reference solution of `kits/tandem-long-horizon`).
