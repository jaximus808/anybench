# project-tracker

A multi-user project tracker API (teams, projects, boards, cards, comments, sprints, automation
rules, notifications and more) on plain `node:http`.
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
| `src/app.ts` | `createApp(options)`: the `http.Server`, the router, and the request steps of section 0.3 (scheduler, auth, rate limit, API key checks, idempotency, body). `AppOptions` documents every option. |
| `src/core.ts` | The state and its data file, creation order, record views, cursors, quotas, the change pipeline (section 0.8), the scheduler (0.9), cascades and the card mutations shared by routes, rule actions and jobs. |
| `src/util.ts` | Errors, field validators, dates, ids, tokenizing, CSV and HTML escaping. |
| `src/r_basics.ts` | Auth, teams, plans, projects, boards and columns, webhooks, the audit log, API keys. |
| `src/r_cards.ts` | Cards, comments, search, custom fields, team labels, checklists, dependencies. |
| `src/r_more.ts` | Sprints, templates, recurrences, notifications and watchers, attachments, activity and history. |
| `src/r_rules.ts` | Automation rules: validation, the engine (pipeline step 2) and runs. |
| `src/r_extra.ts` | Saved views, import and export, reports, time tracking, invitations, archive and trash, HTML pages. |
| `src/migrate.ts` | Converts a 1.x data file to the 2.0 model. |
| `src/webhooks.ts` | Background webhook delivery: signing, retries on unref'd timers, timeouts. |
| `test/support.ts` | The tests' HTTP client, fake clock, team setup and webhook event log. |
| `fixtures/tracker-v1.json` | A data file written by tracker 1.x (format version 1). The new version must migrate it. |

Every route of the task is implemented (the reference solution of `kits/tandem-long-horizon`,
workload `project-tracker-xl`).
