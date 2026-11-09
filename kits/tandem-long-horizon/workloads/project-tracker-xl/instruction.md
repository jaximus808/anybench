# Task: build the project tracker API

The repository in your working directory is the start of **project-tracker 2.0**, a multi-user
project tracker (think a small Trello or Linear) on plain `node:http`. Read its `README.md`. Today
it only answers `GET /health`. Build the whole application described below: accounts, teams with
roles, projects, boards and columns, cards, threaded comments with @mentions, search, outgoing
webhooks, rate limiting, persistence with a migration from the 1.x data format, an audit log, API
keys with scopes, plans and quotas, idempotent requests, custom fields, team labels, checklists,
card dependencies, sprints and velocity, card templates, recurring cards, an automation rule
engine, notifications and watchers, attachments, activity feeds and card history, saved views,
import and export, reports, time tracking, invitations, an archive with a trash, and server-rendered
HTML pages.

The features are meant to work together: an automation rule fires on card events, changes cards,
posts comments that mention people, sends notifications, causes webhook deliveries, respects
quotas, permissions, WIP limits and dependencies, and shows up in the audit log, the activity feed
and the exports. Section 0.8 says exactly how one change flows through all of them.

Clients depend on every route, field, status code, error code, order and formula written here, so
follow the contract exactly. Where this document says "exactly", "in this order" or gives a
formula, it is relied on.

## Ground rules

- No new dependencies. Use Node 22 built-ins only (`node:http`, `node:crypto`, `node:fs`,
  `node:path`, `node:test`, global `fetch`).
- `src/app.ts` must keep exporting `createApp(options?: AppOptions): http.Server`. It returns a
  server that is **not** listening yet; callers call `.listen()`. Keep `GET /health`. The
  `AppOptions` interface already in `src/app.ts` is the contract for options (section 0.6).
- `createApp` is synchronous. If `dataFile` is set it reads (and, for a 1.x file, migrates) the
  file before it returns.
- Two apps created in the same process share no state (many apps run side by side in one process).
- Node runs the `.ts` files directly (type stripping): erasable TypeScript only, `.ts` import
  extensions.
- Organise the code however you like, but add your own tests under `test/` (`npm test` must pass).
  Test real behavior over HTTP.
- Do not edit `fixtures/tracker-v1.json`.
- Nothing in this contract depends on randomness: ids, tokens and generated secrets may be random,
  but no observable order or value may depend on it.

---

## 0. Conventions (apply to every route)

### 0.1 Requests and responses

- Request and response bodies are JSON (`content-type: application/json; charset=utf-8` on every
  response that has a body), with four exceptions, each defined in its section: the upload
  `POST /cards/:cardId/attachments` takes raw bytes (section 24), `GET
  /attachments/:attachmentId/content` answers raw bytes (section 24), `GET
  /projects/:projectId/export?format=csv` answers CSV text (section 27), and the `GET /html/…`
  routes answer HTML (section 32). Errors are always JSON, on every route. `204` and `304`
  responses have no body.
- A request body larger than 64 KiB (65536 bytes) answers `413 body_too_large`; on
  `POST /cards/:cardId/attachments`, `POST /projects/:projectId/import` and
  `POST /teams/:teamId/import` the limit is 1 MiB (1048576 bytes). A body that is not valid JSON
  answers `400 invalid_json`. Where a route takes a JSON body, the body must be a JSON object;
  anything else (missing, an array, a string) answers `400 invalid_body`. A zero-length body is
  missing (`400 invalid_body`); a body of only whitespace is not valid JSON (`400 invalid_json`).
  The request's `content-type` is not checked on JSON routes. Routes that take no
  body ignore any body sent to them, and every route ignores query parameters it does not list.
  A listed query parameter sent with an empty value (`?limit=`) is present, not absent: it is
  checked by that parameter's own rule, so for example `?limit=`, `?cursor=`, `?archived=`,
  `?includeArchived=`, `?unread=` and `?format=` answer `400 invalid_query`, and an empty filter
  such as `?projectId=` or `?action=` matches nothing; only `q` treats a blank value as no
  condition (section 7).
- Unknown fields in a body are ignored. A known field with the wrong type or an out-of-range
  value answers `400 invalid_body`. "Trimmed" means leading and trailing whitespace is removed
  before the length check, and the trimmed value is what is stored. A field documented as
  `string | null` accepts `null` to clear it.
- A `PATCH` body must contain at least one of the route's updatable fields, otherwise
  `400 invalid_body`.
- Unknown paths, and known paths with a method that is not listed, answer `404 not_found`.

### 0.2 Errors

Every error answers with its status and the body
`{ "error": { "code": "<code>", "message": "<human readable>" } }`. A few errors add a third key,
`details`, an object; they are the ones whose `details` this document defines (for example
`quota_exceeded` in section 13), and those always carry it exactly as defined. The complete list
of codes:

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_body`, `invalid_query`, `invalid_header`, `invalid_assignee`, `wrong_password`, `invalid_field_value`, `field_required`, `import_invalid` |
| 401 | `unauthorized`, `invalid_credentials` |
| 403 | `forbidden`, `api_key_not_allowed`, `insufficient_scope` |
| 404 | `not_found`, `user_not_found` |
| 409 | `email_taken`, `handle_taken`, `already_member`, `owner_required`, `key_taken`, `project_archived`, `card_archived`, `wip_limit_reached`, `column_not_empty`, `last_column`, `comment_deleted`, `quota_exceeded`, `downgrade_blocked`, `idempotency_conflict`, `field_name_taken`, `label_taken`, `dependency_exists`, `dependency_cycle`, `blocked`, `sprint_active`, `sprint_state`, `template_in_use`, `timer_running`, `no_timer`, `invite_expired`, `invite_used`, `card_not_archived` |
| 413 | `body_too_large` |
| 429 | `rate_limited` |
| 500 | `internal` |

The codes inside `details` (such as the import's `unknown_column`) and the codes recorded in rule
runs and recurrences (`lastError`) are not response codes and are not listed here.

An unexpected failure answers `500 internal`; no request this document gives an outcome to may
answer it.

### 0.3 The order checks run in

Before any check, the scheduler runs (section 0.9). Then, when a request breaks several rules,
the **first** failing check in this list decides the answer:

1. Route exists, else `404 not_found`.
2. Authentication (every route except `GET /health`, `POST /auth/register`, `POST /auth/login`
   and `GET /plans`), with a session token (section 1) or an API key (section 12), else
   `401 unauthorized`.
3. Rate limit (section 9), else `429 rate_limited`.
   - 3a. API key restrictions (section 12.3): `403 api_key_not_allowed`, then
     `403 insufficient_scope`. Session tokens skip this step.
   - 3b. Idempotency (section 14): `400 invalid_header`, `409 idempotency_conflict`, or the replay
     of a stored response.
4. For routes that take a body: `413 body_too_large`, then (JSON bodies only) `400 invalid_json`,
   then `400 invalid_body` if the body is not a JSON object (missing, an array, a string, …).
5. Every resource named in the **path** exists and the caller can see it, else `404 not_found`.
   A caller can see a team, and everything inside it, only while they are a member of that team
   (any role). Everything inside a team the caller is not a member of answers `404 not_found`,
   never `403`. Some records are visible only to one user (their own API keys, notifications,
   private views, invitations addressed to them); anyone else gets `404 not_found` for them.
6. The caller's role allows the action (the **Role** column of each route), else `403 forbidden`.
7. Body and query validation: `400 invalid_body` / `400 invalid_query`, then checks on ids
   and values named in the body (`400 invalid_body`, `400 invalid_assignee`,
   `404 user_not_found`, `400 invalid_field_value`, `400 field_required`, as each route says).
8. State conflicts, the `409` codes: `project_archived` first, then `card_archived`, then the
   route's other `409` codes in the order its **Errors** column lists them.

A route's **Errors** column lists the codes particular to it; the codes of steps 1 to 6 (`404
not_found` for an unknown or invisible path resource, `401`, `429`, the `403`s, `413`,
`invalid_json`, `invalid_header`, `idempotency_conflict`) apply to every route they can apply to,
whether listed or not. `project_archived` and `card_archived` apply to the routes section 3 and
section 31 say they do, whether listed or not.

### 0.4 Roles

A team member has exactly one role. From most to least powerful: `owner`, `admin`, `member`,
`viewer`. A role column entry such as "admin+" means `admin` or `owner`; "member+" means `owner`,
`admin` or `member`; "viewer+" means any member. A team has exactly one `owner` at all times.
"Any user" means any authenticated caller, whatever their teams.

### 0.5 Ids, timestamps, ordering and pagination

- Ids are non-empty opaque strings, unique within their kind and never reused. Ids of records
  migrated from a 1.x file are kept (section 10.3); new ids must not collide with them.
- Timestamps are ISO-8601 strings produced by `new Date(now()).toISOString()`, where `now` is
  the clock option (section 0.6). Dates (`dueDate`, query filters, sprint dates) are `YYYY-MM-DD`
  strings naming a real calendar date (`2026-02-30` is invalid). **Today** is
  `new Date(now()).toISOString().slice(0, 10)`. The **start** of a date `D` is the instant
  `Date.parse(D + "T00:00:00.000Z")`; the **end** of `D` is the start of the next date. A
  timestamp `T` falls **on** date `D` when `start(D) <= Date.parse(T) < end(D)`.
- **Creation order.** Lists without an explicit order are oldest first. Records migrated from a
  1.x file (section 10) always come before every record created after loading, whatever the
  timestamps (small fake clocks are common). Within each of those two groups, records are sorted
  ascending by their timestamp (`createdAt`, `joinedAt`, `at`), ties broken by the order in
  which the server created them (for migrated records: the order of the 1.x file). This order is
  part of the state and survives a restart. "Newest first" is exactly the reverse.
- **Paginated lists** are the routes whose query column lists `limit` and `cursor`. They take
  `?limit=` (integer 1 to 100, default 20) and `?cursor=`, and answer
  `{ "items": [...], "nextCursor": string | null }` (search and view results add `total`).
  `nextCursor` is opaque; passing it back (with the same other query parameters) returns the
  next page. While the data does not change, following `nextCursor` from the first page visits
  every matching item exactly once, in order. It is `null` on the last page. A `limit` that is
  not an integer in range, or a `cursor` the server did not issue for that route, answers
  `400 invalid_query`. A cursor belongs to the app that issued it: after a restart (a new
  `createApp` on the same `dataFile`), a cursor from before it answers `400 invalid_query`.
- Other lists answer `{ "items": [...] }` with every item.
- **`updatedAt`.** Every record that has `updatedAt` starts with it equal to `createdAt`. It
  changes on every successful request that changes that record through its own routes (`PATCH`,
  `PUT`, rotate-secret, sprint start and complete, checklist item `PATCH`, archive and restore,
  …) and on the changes its section names (a card's sprint and field values), even when the new
  values equal the old ones. It never changes on cascades, scheduler runs (recurrence runs
  included) or rule auto-disabling. A record's `createdBy` (or `ownerId`, `invitedBy`) never
  changes.

### 0.6 Options

`createApp(options)` takes (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `dataFile` | none (memory only) | Path of the JSON data file (section 10). |
| `now` | `Date.now` | The clock in milliseconds since the epoch. Use it for **every** timestamp, token and key expiry, rate-limit window, idempotency expiry, invitation expiry, timer and scheduled job. The clock is moved by hand; nothing may assume it advances on its own. |
| `tokenTtlMs` | `86400000` | Token lifetime (section 1). |
| `rateLimit` | `{ limit: 1000, windowMs: 60000 }` | Per-credential rate limit (section 9). |
| `webhooks.retryDelaysMs` | `[1000, 5000, 30000]` | Wait before each retry (section 8). |
| `webhooks.timeoutMs` | `5000` | Time allowed for one delivery attempt. |
| `defaultPlan` | `"free"` | The plan of every new team and every migrated team (section 13): `"free"`, `"team"` or `"business"`. |
| `idempotencyTtlMs` | `86400000` | How long a stored idempotent response is kept (section 14). |
| `automation.maxDepth` | `3` | How deep rule actions may trigger further rules (section 22). |
| `trash.retentionMs` | `2592000000` | How long an archived card stays in the trash before it is purged (section 31). |
| `invites.ttlMs` | `604800000` | Invitation lifetime (section 30). |

Nested options merge per key: `{ webhooks: { timeoutMs: 100 } }` keeps the default
`retryDelaysMs`. `automation.maxDepth: 0` (no rule ever runs) and `trash.retentionMs: 0` (archived
cards are purged on the next request) are allowed.

Webhook attempts (section 8) are the only work that uses real timers. Everything else that
depends on time reads `now()` when a request arrives.

### 0.7 Visibility of the new records

Every record below belongs to one team, through the path that contains it, and follows rule 5 of
section 0.3: custom fields, checklist items, sprints and templates (through their project); team
labels, rules, rule runs, invitations, saved views (through their team); attachments and time
entries (through their card); recurrences (through their board). API keys, notifications,
notification settings and the running timer belong to one user.

### 0.8 Events and the change pipeline

A **change** is one unit of effect: the effect of one successful request, of one automation action
(section 22), or of one scheduler job (section 0.9). A change appends its audit entry when the
table of section 11 gives it one, and emits the events the table below gives it. An **event** is
`{ event, teamId, actorId, via, occurredAt, data }`:

- `actorId`: for a request, the caller; for an automation action, the rule's `createdBy`; for a
  recurrence, the recurrence's `createdBy`; for the due job and the trash purge, `null`.
- `via`: `null` for a request; `{ "type": "rule", "ruleId": <id>, "runId": <id> }` for an
  automation action; `{ "type": "recurrence", "recurrenceId": <id> }` for a recurrence;
  `{ "type": "schedule" }` for the due job and the trash purge.
- `occurredAt`: `now()` of the request or job.
- `data`: a snapshot taken right after that change, before any later change of the same
  pipeline. `card`, `comment`, `member`, `sprint` and `attachment` are the same objects the
  routes return.

| Event | Emitted by | `data` |
| --- | --- | --- |
| `card.created` | `POST /columns/:columnId/cards`, `POST /templates/:templateId/cards`, a recurrence (section 21) | `{ card }` |
| `card.updated` | `PATCH /cards/:cardId`, `PUT` and `DELETE /cards/:cardId/fields/:fieldId`, `POST /sprints/:sprintId/cards` and `DELETE /sprints/:sprintId/cards/:cardId` (one event per card whose `sprintId` changed, in body order), the actions `set_assignee`, `add_label`, `remove_label`, `set_priority`, `set_field`, `add_to_sprint` | `{ card, fields }` |
| `card.moved` | `POST /cards/:cardId/move`, the action `move_to_column` | `{ card, fromColumnId, toColumnId }` |
| `card.deleted` | `DELETE /cards/:cardId`, the trash purge (section 31) | `{ card }` (as it was before deletion) |
| `card.archived` | `POST /cards/:cardId/archive`, the action `archive_card` | `{ card }` |
| `card.restored` | `POST /cards/:cardId/restore` | `{ card }` |
| `card.due` | the due job (section 5) | `{ card }` |
| `comment.created` | `POST /cards/:cardId/comments`, the action `add_comment` | `{ comment }` |
| `checklist.completed` | `PATCH /checklist/:itemId`, `DELETE /checklist/:itemId` (section 17) | `{ card }` |
| `attachment.added` | `POST /cards/:cardId/attachments` | `{ attachment }` |
| `member.added` | `POST /teams/:teamId/members`, `POST /invites/:token/accept` | `{ member }` |
| `member.removed` | `DELETE /teams/:teamId/members/:userId` | `{ userId }` |
| `sprint.started` | `POST /sprints/:sprintId/start` | `{ sprint }` |
| `sprint.completed` | `POST /sprints/:sprintId/complete` | `{ sprint }` |

`fields` in `card.updated`: for `PATCH /cards/:cardId`, the route's updatable field names present
in the body, sorted ascending (present even if the value did not change); for the field-value
routes, `["customFields"]`; for the sprint routes and `add_to_sprint`, `["sprintId"]`; for an
action, the one card attribute it changes (`assigneeId`, `labels`, `priority`, `customFields`).
Nothing else emits events. **Cascades** (effects a section calls a cascade, such as cards
unassigned when a member leaves, or field values removed when a field is deleted) emit no events,
append no audit entry, create no notifications and never change any record's `updatedAt`.
Imports (section 27) emit no events.

**The pipeline.** One request (or one scheduler job) runs exactly these steps, in this order:

1. Apply the change. Append its audit entry (if it has one), then append its events to the
   **queue**, each with depth `0`.
2. Take the oldest event not yet taken from the queue. Run the automation rules it triggers
   (section 22), each in rule creation order; each action that changes something is a change:
   its audit entry is appended and its events are appended to the end of the queue, with depth
   one more than the event that triggered the rule.
3. Repeat step 2 until every event in the queue has been taken.
4. For every event, in the order it entered the queue: append its activity entry (section 25),
   create its notifications (section 23), and create its webhook deliveries (section 8).
5. Write the data file (section 10).
6. Send the response. The response body shows the state **after** step 3: for example, the card
   returned by `POST /columns/:columnId/cards` already carries a label that a rule added to it,
   although the `card.created` event's snapshot does not.

A failed request runs no pipeline and changes no state, except that the rate limit counts it
(section 9) and the scheduler jobs that ran when it arrived (section 0.9) stay done.

### 0.9 The scheduler

Some changes happen at a time rather than on a request: the due job (section 5), recurrences
(section 21) and the trash purge (section 31). The app keeps a set of pending **jobs**, each with a
due instant. When **any** request arrives (every path and method, `GET /health`, unknown routes and
requests that end in `401` or `429` included), before check 1 of section 0.3, the app runs every
job whose due instant is `<= now()`, one after the other, in this order: due instant ascending,
then job kind (due job, then recurrence, then trash purge), then the creation order of the record
the job belongs to (the card or the recurrence). A job that a run schedules and that is already due
runs in the same pass, in its place in that order. Each job is a change with its own pipeline
(section 0.8; its step 6 sends nothing). No timers: nothing runs between requests, and `createApp`
runs no job. Jobs are part of the state, so they survive a restart.

---

## 1. Accounts and auth (`auth`)

A **user** is `{ id, email, name, handle, createdAt }`. It never includes a password or a hash.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /auth/register` | public | `{ email, password, name, handle }` | `201 <user>` | `400 invalid_body` · `409 email_taken` · `409 handle_taken` |
| `POST /auth/login` | public | `{ email, password }` | `200 { token, expiresAt }` | `400 invalid_body` · `401 invalid_credentials` |
| `POST /auth/logout` | any user | | `204` | |
| `GET /me` | any user | | `200 <user>` | |
| `PATCH /me` | any user | `{ name?, handle? }` | `200 <user>` | `400 invalid_body` · `409 handle_taken` |
| `POST /me/password` | any user | `{ currentPassword, newPassword }` | `204` | `400 invalid_body` · `400 wrong_password` |

- `email`: a string, trimmed, at most 254 chars, containing exactly one `@` with at least one
  character before and after it. Emails are stored lowercased and compared case-insensitively.
  `email_taken` is checked before `handle_taken`.
- `password` / `newPassword`: a string of 8 to 200 chars (not trimmed).
- `name`: a string, trimmed, 1 to 100 chars.
- `handle`: a string matching `^[a-z0-9_]{3,20}$` exactly (lowercase only; it is not trimmed or
  lowercased for you). Handles are unique across all users (`409 handle_taken` when another user
  holds it; `PATCH /me` with your own current handle is fine).
- Store passwords only as a salted `crypto.scrypt` hash.
- `login`: a body whose `email` or `password` is not a string answers `400 invalid_body`. The
  email is trimmed and compared case-insensitively. An unknown email or a wrong password answers `401 invalid_credentials`. Success returns a new
  opaque token of at least 20 chars that does not start with `trk_`, and `expiresAt` =
  `new Date(issuedAt + tokenTtlMs).toISOString()`, where `issuedAt` is `now()` at login. A user
  may hold many tokens at once.
- Authenticated routes take `Authorization: Bearer <token>` (or an API key in the same header,
  section 12). The scheme is exactly `Bearer` followed by one space; anything else (`bearer`,
  `Basic …`, no token) is malformed. A missing or malformed header, an unknown, revoked or expired token answers
  `401 unauthorized`. A token is expired when `now() >= issuedAt + tokenTtlMs`.
- `logout` revokes the token it was called with (only that one).
- `POST /me/password`: both fields are validated first (`currentPassword` must be a string,
  `newPassword` 8 to 200 chars, else `400 invalid_body`); then a wrong `currentPassword` answers
  `400 wrong_password`. On success the password changes and **every** session token of the user
  is revoked, the calling one included. API keys are not revoked.
- `PATCH /me` with a new handle affects only mentions written after the change.

## 2. Teams and roles (`teams`)

A **team** is `{ id, name, ownerId, plan, createdAt, myRole }`, where `myRole` is the caller's
role and `plan` is the team's plan (section 13).
A **member** is `{ userId, email, name, handle, role, joinedAt }`.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams` | any user | `{ name }` | `201 <team>` (caller is `owner`, `plan` is `defaultPlan`) | `400 invalid_body` |
| `GET /teams` | any user | | `200 { items: <team>[] }` teams the caller belongs to, in creation order of the teams | |
| `GET /teams/:teamId` | viewer+ | | `200 <team>` | `404 not_found` |
| `PATCH /teams/:teamId` | admin+ | `{ name }` | `200 <team>` | `400 invalid_body` |
| `DELETE /teams/:teamId` | owner | | `204` | |
| `GET /teams/:teamId/members` | viewer+ | | `200 { items: <member>[] }` oldest `joinedAt` first | |
| `POST /teams/:teamId/members` | admin+ | `{ email, role }` | `201 <member>` | `400 invalid_body` · `404 user_not_found` · `409 already_member` · `409 quota_exceeded` |
| `PATCH /teams/:teamId/members/:userId` | admin+ | `{ role }` | `200 <member>` | `400 invalid_body` · `409 owner_required` |
| `DELETE /teams/:teamId/members/:userId` | admin+, or any member removing themselves | | `204` | `409 owner_required` |
| `POST /teams/:teamId/transfer` | owner | `{ userId }` | `200 <team>` | `400 invalid_body` |

- Team `name`: a string, trimmed, 1 to 100 chars.
- Adding a member: `email` must pass the rules of section 1 (else `400 invalid_body`); it is
  then trimmed and matched case-insensitively against registered users (`404 user_not_found` if
  none); `role` is one of `admin`, `member`, `viewer` (`owner` or
  anything else is `400 invalid_body`). A user who is already a member is `409 already_member`.
  Then the `members` quota (section 13): the team must have fewer members than its limit.
  Adding a member who has a pending invitation to the team (section 30), expired or not, marks
  that invitation `accepted` with `acceptedAt` = `now()` (a cascade).
- In `PATCH /teams/:teamId/members/:userId` and `DELETE …/members/:userId`, a `userId` that is not
  a member of the team answers `404 not_found`. `PATCH` sets `role` to `admin`, `member` or
  `viewer` (else `400 invalid_body`). Changing the owner's role, or removing the owner (even by
  the owner), answers `409 owner_required`. Admins may change the role of, or remove, any
  non-owner member, other admins included. A `PATCH` to the member's current role succeeds and is
  audited (`member.role_changed` with equal `from` and `to`).
- A `member` or `viewer` calling `DELETE …/members/:userId` for someone else gets `403 forbidden`.
- **When a user leaves or is removed** (cascades): every card in the team assigned to them
  becomes unassigned (`assigneeId: null`), archived projects and archived cards included; they
  stop watching every card of the team (section 23); their private saved views of the team are
  deleted (section 26); their running timer, if it is on a card of the team, is discarded
  (section 29); every `user`-type custom field value naming them in the team, on cards and on
  templates, is removed (section 15). Their comments, rules, recurrences, templates, time entries and attachments stay. Cascades
  never change any record's `updatedAt`.
- `transfer`: `userId` must name another member of the team (else `400 invalid_body`). The target
  becomes `owner`, the previous owner becomes `admin`, and `ownerId` changes. The response is the
  team as the caller now sees it (`myRole: "admin"`).
- Deleting a team deletes everything in it (projects and everything in them, webhooks, labels,
  rules and their runs, invitations, views, notifications about it, activity, audit log). Its
  members simply stop seeing it.

## 3. Projects (`projects`)

A **project** is `{ id, teamId, name, key, description, archived, createdAt, updatedAt }`.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams/:teamId/projects` | admin+ | `{ name, key, description? }` | `201 <project>` (`archived: false`) | `400 invalid_body` · `409 key_taken` · `409 quota_exceeded` |
| `GET /teams/:teamId/projects` | viewer+ | `?archived=false\|true\|all` (default `false`) | `200 { items: <project>[] }` oldest first | `400 invalid_query` |
| `GET /projects/:projectId` | viewer+ | | `200 <project>` | `404 not_found` |
| `PATCH /projects/:projectId` | admin+ | `{ name?, description?, archived? }` | `200 <project>` | `400 invalid_body` |
| `DELETE /projects/:projectId` | admin+ | | `204` | |

- `name`: trimmed, 1 to 100 chars. `description`: a string of at most 2000 chars, default `""`.
  `archived`: a boolean.
- `key`: matches `^[A-Z][A-Z0-9]{1,5}$` exactly. Keys are unique within a team, archived projects
  included (`409 key_taken`). A key never changes: a `PATCH` body containing `key` answers
  `400 invalid_body`. Deleting a project frees its key, so a new project in the team may reuse it.
  After `key_taken`, the `projects` quota (section 13).
- `?archived=false` lists active projects, `true` only archived ones, `all` both.
- **Archived projects are read-only.** Every write to anything inside an archived project answers
  `409 project_archived`: boards, columns, cards (create, update, move, delete, archive,
  restore), comments, card field values, custom fields, checklist items, dependencies (when
  either card is in an archived project), sprints and their card lists, templates (and
  instantiating one), recurrences, attachments and time entries (and starting a timer on a card
  of it), and the project import (section 27). The only writes that still work are watching and
  unwatching cards, stopping a running timer, deleting a time entry, and `PATCH` and `DELETE` of
  the project itself, so it can be renamed, unarchived or deleted. Reads, exports and reports
  still work.
- Deleting a project deletes everything in it: boards, columns, cards, comments, custom fields,
  checklist items, sprints, templates, recurrences, attachments (their bytes stop counting toward
  storage), time entries, and every dependency that involves one of its cards.
- `updatedAt` changes on every successful `PATCH`.

## 4. Boards and columns (`boards`)

A **board** is `{ id, projectId, name, columns: <column>[], createdAt }`, with `columns` ordered
by `position`. A **column** is `{ id, boardId, name, position, wipLimit, category }`. Within a
board, column positions are always `0 .. n-1` with no gaps.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /projects/:projectId/boards` | admin+ | `{ name, columns? }` | `201 <board>` | `400 invalid_body` · `409 project_archived` |
| `GET /projects/:projectId/boards` | viewer+ | | `200 { items: <board>[] }` oldest first | |
| `GET /boards/:boardId` | viewer+ | | `200 <board>` | `404 not_found` |
| `PATCH /boards/:boardId` | admin+ | `{ name }` | `200 <board>` | `400 invalid_body` · `409 project_archived` |
| `DELETE /boards/:boardId` | admin+ | | `204` | `409 project_archived` |
| `POST /boards/:boardId/columns` | admin+ | `{ name, position?, wipLimit?, category? }` | `201 <column>` | `400 invalid_body` · `409 project_archived` |
| `PATCH /columns/:columnId` | admin+ | `{ name?, position?, wipLimit?, category? }` | `200 <column>` | `400 invalid_body` · `409 project_archived` |
| `DELETE /columns/:columnId` | admin+ | `?moveTo=<columnId>` | `204` | `400 invalid_query` · `409 project_archived` · `409 last_column` · `409 column_not_empty` |

- Board `name` and column `name`: trimmed, 1 to 50 chars. Column names need not be unique.
- `columns` on create: an array of 1 to 20 column names; default
  `["To do", "In progress", "Done"]`. They get positions in array order and `wipLimit: null`.
  Their categories: with one column, `todo`; otherwise the first is `todo`, the last is `done`
  and every other one is `in_progress` (so the default columns are `todo`, `in_progress`,
  `done`).
- `category`: one of `todo`, `in_progress`, `done`; default `todo` for a created column. A
  column whose category is `done` is a **done column**.
- **Changing a category** (cascade): when a column becomes a done column, each non-archived card
  in it with `completedAt: null` gets `completedAt` = `now()`; when a done column stops being
  one, each non-archived card in it gets `completedAt: null`. Archived cards are not touched
  (section 31 sets their `completedAt` on restore). Card history (section 25) records nothing.
- `wipLimit`: `null` (no limit) or an integer from 1 to 1000. Default `null`.
- Create a column at `position` (an integer `0 .. n`, where `n` is the board's current column
  count; default `n`, the end). Columns at or after that position shift right by one.
- `PATCH` with `position` (an integer `0 .. n-1`) moves the column: it is taken out of the list
  and inserted so that it ends up at that index; the others keep their relative order. Lowering
  `wipLimit` below the column's current card count is allowed (the limit applies only to cards
  arriving later).
- `DELETE /columns/:columnId`: when `?moveTo=` is present (even with an empty value), it must
  name **another column of the same board**, else `400 invalid_query`. This is checked at step 7,
  so on a board's last column any `moveTo` answers `400`, and an invalid `moveTo` answers `400`
  even when the column is empty. Then the 409s, in this order: the last column of a board can't
  be deleted (`409 last_column`); a column that still has non-archived cards answers
  `409 column_not_empty` unless `moveTo` was given, in which case those cards are appended to the
  end of that column, keeping their order, and the WIP limit is not checked. The moved cards'
  `completedAt` follows the completion rule of section 5 for the target column (entering a done
  column from one that is not: `now()`; leaving a done column for one that is not: `null`;
  otherwise unchanged), and their history records nothing (a cascade). Archived cards of a
  deleted column (cascade) get the `columnId` of the `moveTo` column if given, else of the board's
  column at position 0 after the delete. Remaining columns are renumbered without gaps.
- Deleting a board deletes its columns, cards (archived ones included), their comments and
  everything else that belongs to those cards, and the board's recurrences.

## 5. Cards (`cards`)

A **card** is

```
{ id, number, key, boardId, columnId, position, title, description, assigneeId, labels,
  dueDate, priority, points, sprintId, customFields, checklist, blocked, completedAt,
  minutesLogged, archived, archivedAt, createdBy, createdAt, updatedAt }
```

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /columns/:columnId/cards` | member+ | `{ title, description?, assigneeId?, labels?, dueDate?, priority?, points?, sprintId?, customFields?, position? }` | `201 <card>` | `400 invalid_body` · `400 invalid_assignee` · `400 invalid_field_value` · `400 field_required` · `409 project_archived` · `409 quota_exceeded` · `409 wip_limit_reached` |
| `GET /boards/:boardId/cards` | viewer+ | `?columnId=` | `200 { items: <card>[] }` | `400 invalid_query` |
| `GET /cards/:cardId` | viewer+ | | `200 <card>` | `404 not_found` |
| `PATCH /cards/:cardId` | member+ | `{ title?, description?, assigneeId?, labels?, dueDate?, priority?, points?, sprintId?, customFields? }` | `200 <card>` | `400 invalid_body` · `400 invalid_assignee` · `400 invalid_field_value` · `400 field_required` · `409 project_archived` · `409 card_archived` · `409 sprint_state` |
| `POST /cards/:cardId/move` | member+ | `{ columnId, position? }` | `200 <card>` | `400 invalid_body` · `409 project_archived` · `409 card_archived` · `409 blocked` · `409 wip_limit_reached` |
| `DELETE /cards/:cardId` | member+ | | `204` | `409 project_archived` |

- `number` is the card's sequence number within its **project** (across all of the project's
  boards), starting at 1 and never reused, even after a card is deleted. `key` is
  `"<project key>-<number>"`, for example `"ENG-12"`. `createdBy` is the creator's user id (for a
  card made by a recurrence, the recurrence's `createdBy`).
- `title`: trimmed, 1 to 200 chars. `description`: a string of at most 10000 chars, default `""`.
- `assigneeId`: `null` (default) or a string. A value that is neither is `400 invalid_body`. A
  string that is not the id of a team member whose role is `owner`, `admin` or `member` (unknown
  id, not a member, a `viewer`) answers `400 invalid_assignee`.
  Later role changes don't touch existing assignments; leaving the team does (section 2).
- `labels`: an array of strings (default `[]`). Each label is trimmed and lowercased and must
  then be 1 to 30 chars. The stored value has duplicates removed and is sorted ascending
  (JavaScript default string order). The limit is on the result: more than 10 distinct labels
  after this normalisation is `400 invalid_body` (an array of 12 entries that reduces to 5 is
  fine). Card labels are free strings; the team label catalogue (section 16) does not restrict
  them.
- `dueDate`: `null` (default) or a `YYYY-MM-DD` date.
- `priority`: one of `none`, `low`, `medium`, `high`, `urgent`; default `none`.
- `points`: `null` (default) or one of the integers `0, 1, 2, 3, 5, 8, 13, 21`.
- `sprintId`: `null` (default) or the id of a sprint of the card's project whose `state` is
  `planned` or `active` (anything else, a completed sprint or another project's sprint included,
  is `400 invalid_body`). A completed sprint is frozen: a `PATCH` with `sprintId` (any value) on a
  card whose current sprint is completed answers `409 sprint_state` (section 19).
- `customFields`: an object of custom field values (section 15). On create, it is the initial
  set of values (default `{}`); on `PATCH`, it is merged into the card's values: a key with a
  value sets that field, a key with `null` removes it, keys not given are kept.
- `checklist` is `{ total, done }`, the number of checklist items of the card and how many are
  done (section 17). `blocked` is `true` when the card has at least one open blocker (section
  18). `minutesLogged` is the sum of the card's time entries (section 29). `archived` and
  `archivedAt` are section 31's (`false` and `null` for a card not archived). None of these four
  is in a body: sent in a body they are unknown fields and ignored.
- **Validation order** of create and `PATCH`, all at step 7: first every field's own rule
  (`400 invalid_body`, including `customFields` not being an object and `sprintId`), then
  `assigneeId` (`400 invalid_assignee`), then the custom field values (`400 invalid_field_value`,
  then `400 field_required`, section 15).
- **Positions.** Within a column, the positions of its non-archived cards are always `0 .. n-1`
  with no gaps, and every list of cards in a column is ordered by position. Creating a card
  inserts it at `position` (an integer `0 .. n`, default `n`, the end); later cards shift down by
  one. Deleting, archiving or moving a card out closes the gap. An archived card has
  `position: null`.
- **Move.** `columnId` must be a column of the **same board** (else `400 invalid_body`).
  `position` is the index the card will have in the target column after the move: an integer
  from `0` to `k`, where `k` is the number of *other* cards in the target column (default `k`, the
  end). Moving within the same column reorders it. The relative order of all other cards never
  changes. `card.moved` and card history (section 25) record a move within the same column too,
  with `fromColumnId` equal to `toColumnId`.
- **Blocked.** Moving a card from a column that is not a done column into a done column, while
  the card is `blocked`, answers `409 blocked`. Moving between two done columns, or out of a done
  column, is never blocked. Creating a card directly in a done column is never blocked.
- **WIP limit.** Creating a card in, or moving a card into a **different** column whose
  `wipLimit` is not `null` and already holds `wipLimit` or more non-archived cards, answers
  `409 wip_limit_reached`. Reordering within a column is never blocked.
- **Completion.** `completedAt` is `null` while the card is in a column that is not a done
  column. When a card is created in a done column, or moves into one from a column that is not,
  `completedAt` becomes `now()`. Moving between done columns keeps it; moving out of a done column
  sets it to `null`.
- `GET /boards/:boardId/cards` lists the board's non-archived cards ordered by column position,
  then card position. `?columnId=` narrows to one column; a value that is not a column of this
  board, the empty value included, answers `400 invalid_query`.
- `updatedAt` changes on `PATCH`, on move, on archive and restore of that card and on every
  change to its custom field values or sprint made by a route or action (not when a neighbour
  shifts it, and not on cascades).
- **The due job.** A card has at most one pending due job. Whenever a request, action or import
  sets a card's `dueDate` (present in the body, whether or not it changed) to a date whose start is later than `now()` (on create, or on a change of
  `dueDate`), the card's due job is (re)scheduled at the start of that date. Setting `dueDate` to
  `null`, or to a date whose start is `<= now()`, cancels the pending job without scheduling one.
  Deleting the card cancels it. When the job runs, it emits `card.due` (actor `null`, via
  `{ "type": "schedule" }`, no audit entry) if, at that moment, the card is not archived, its
  `completedAt` is `null` and its project is not archived; otherwise it does nothing. Either way
  the job is then gone (it runs once).
- Deleting a card deletes its comments, checklist items, attachments, time entries, watchers,
  and the dependencies that involve it, and discards any running timer on it (section 29), also
  when the card goes with its board, project or team. Notifications about it stay.

## 6. Comments and mentions (`comments`)

A **comment** is

```
{ id, cardId, parentId, authorId, body, mentions, deleted, createdAt, updatedAt, replies }
```

`replies` holds the comment's direct replies, oldest first, each a full comment with its own
`replies`, to any depth.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /cards/:cardId/comments` | member+ | `{ body, parentId? }` | `201 <comment>` (`replies: []`) | `400 invalid_body` · `409 project_archived` · `409 card_archived` · `409 comment_deleted` |
| `GET /cards/:cardId/comments` | viewer+ | | `200 { items: <comment>[] }` top-level comments (`parentId: null`), oldest first, as trees | |
| `GET /comments/:commentId` | viewer+ | | `200 <comment>` (with its subtree) | `404 not_found` |
| `PATCH /comments/:commentId` | the author only | `{ body }` | `200 <comment>` | `400 invalid_body` · `409 project_archived` · `409 card_archived` · `409 comment_deleted` |
| `DELETE /comments/:commentId` | the author, or admin+ | | `204` | `409 project_archived` · `409 card_archived` · `409 comment_deleted` |
| `GET /me/mentions` | any user | `?limit=&cursor=` | `200 { items: <mention>[], nextCursor }` newest first | `400 invalid_query` |

- `body`: trimmed, 1 to 5000 chars.
- `parentId`: `null` (default) or the id of a comment **on the same card** (else
  `400 invalid_body`). Replying to a deleted comment answers `409 comment_deleted`.
- The **Role** column is checked at step 6: on `PATCH`, anyone but the author gets
  `403 forbidden` (owners too); on `DELETE`, anyone who is neither the author nor admin+ gets
  `403 forbidden`. Being the author is enough, whatever the author's current role (a `viewer`
  can edit and delete their own comments). Both still need the caller to see the comment (step 5).
- **Delete is soft.** The comment stays in its thread with `deleted: true`, `body: ""` and
  `mentions: []`, and keeps its replies. `PATCH` or `DELETE` of a deleted comment answers
  `409 comment_deleted`.
- **Mentions.** `mentions` is the list of user ids mentioned in `body`, in order of first
  appearance, without duplicates. A mention is a match of the regular expression
  `(?<![A-Za-z0-9_])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])`; the captured name, lowercased, is a
  handle. A handle counts only if it belongs to a current member of the card's team (any role) and
  is not the comment's author. Everything else is ignored. So `ada@example.com` mentions nobody,
  `@Ada,` mentions the user with handle `ada`, and `@` followed by 21 name characters mentions
  nobody. Mentions are computed when the comment is created and recomputed on every `PATCH`.
- A comment written by the `add_comment` action (section 22) has the rule's `createdBy` as
  `authorId`; its mentions follow the same rules.
- A **mention** item of `GET /me/mentions` is `{ commentId, cardId, teamId, authorId, createdAt }`
  (the comment's `createdAt`). It lists every comment that currently has the caller in
  `mentions`, is not deleted, and belongs to a team the caller is still a member of. Leaving a team
  does not change any comment's `mentions`, so if the user rejoins, those comments are listed again.
- `updatedAt` changes on `PATCH` and on delete. Commenting does not change the card's `updatedAt`.

## 7. Search (`search`)

| Route | Role | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /teams/:teamId/search` | viewer+ | see below, plus `?limit=&cursor=` | `200 { items: <card>[], total, nextCursor }` | `400 invalid_query` |

Query parameters (all optional, combined with AND):

| Param | Meaning |
| --- | --- |
| `q` | Full-text query, at most 200 chars and at most 10 distinct terms (else `400 invalid_query`). Blank, absent, or with no terms after tokenizing (for example `!!!`) means no text condition. |
| `projectId`, `boardId`, `columnId` | Only cards in that project / board / column. An id that is not in this team simply matches nothing. |
| `assigneeId` | Only cards assigned to that user id; the literal `none` means unassigned cards. |
| `label` | May repeat (`?label=a&label=b`). Each value is trimmed and lowercased; the card must have **every** given label. |
| `dueFrom`, `dueTo` | `YYYY-MM-DD` (else `400 invalid_query`). Inclusive bounds on `dueDate`; when either is given, cards without a `dueDate` are excluded. |
| `priority` | One of the five priorities (else `400 invalid_query`). |
| `sprintId` | Only cards in that sprint; the literal `none` means cards in no sprint. |
| `category` | `todo`, `in_progress` or `done` (else `400 invalid_query`): only cards whose column has that category. |
| `blocked` | `true` or `false` (else `400 invalid_query`). |
| `field.<fieldId>` | A custom field condition (section 15.4). |
| `includeArchived` | `true` or `false` (default `false`; anything else is `400 invalid_query`). Cards of archived projects are searched only when `true`. |
| `limit`, `cursor` | Pagination (section 0.5). |

- Archived cards (section 31) are never search results.
- **Tokens.** Text is lowercased, then split on every character that is not `a`-`z` or `0`-`9`;
  empty pieces are dropped. `q` is tokenized the same way into terms (duplicates removed).
- **Match.** A term matches a token when the token **starts with** the term. A card matches `q`
  when every term matches at least one token of the card's title, description, or the bodies of
  its non-deleted comments.
- **Score.** For each term, count the matching tokens (with repetition) in the title (`t`), the
  description (`d`) and all non-deleted comment bodies together (`c`). The card's score is the
  sum over terms of `3*t + d + c`.
- **Order.** With a `q`: score descending, then creation order (oldest first). Without a `q`:
  creation order.
- `total` is the number of matching cards across all pages.

## 8. Webhooks (`webhooks`)

A **webhook** is `{ id, teamId, url, events, active, createdAt, updatedAt }`. Its `secret` is
returned only by create and by rotate-secret, never by any other route.
A **delivery** is
`{ id, webhookId, event, status, attempts, lastStatusCode, lastError, createdAt }`.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams/:teamId/webhooks` | admin+ | `{ url, events, secret?, active? }` | `201 <webhook>` plus `secret` | `400 invalid_body` · `409 quota_exceeded` |
| `GET /teams/:teamId/webhooks` | admin+ | | `200 { items: <webhook>[] }` oldest first | |
| `GET /webhooks/:webhookId` | admin+ | | `200 <webhook>` | `404 not_found` |
| `PATCH /webhooks/:webhookId` | admin+ | `{ url?, events?, active? }` | `200 <webhook>` | `400 invalid_body` |
| `DELETE /webhooks/:webhookId` | admin+ | | `204` | |
| `POST /webhooks/:webhookId/rotate-secret` | admin+ | | `200 <webhook>` plus the new `secret` | |
| `POST /webhooks/:webhookId/test` | admin+ | | `202 { deliveryId }` | |
| `GET /webhooks/:webhookId/deliveries` | admin+ | `?limit=&cursor=` | `200 { items: <delivery>[], nextCursor }` newest first | `400 invalid_query` |

- `url`: an absolute `http:` or `https:` URL (for example `http://127.0.0.1:<port>/…`).
- `events`: a non-empty array of event names from the table of section 0.8, or containing `"*"`
  (all events). Stored de-duplicated and sorted ascending; any list containing `"*"` is stored as
  `["*"]`. Unknown names answer `400 invalid_body`.
- `secret`: a string of 16 to 200 chars; if omitted the server generates one of at least 32 chars.
  `active`: a boolean, default `true`.
- After validation, the `webhooks` quota (section 13).
- Rotating replaces the secret; later attempts are signed with the new one.
- `updatedAt` changes on every successful `PATCH` and on rotate-secret.
- `ping` is not a valid entry of `events` (it is only sent by the test route).

**Delivery.** For each event of section 0.8 (pipeline step 4), every **active** webhook of the
event's team whose `events` match gets one delivery, created with `status: "pending"`,
`attempts: 0`. Attempts happen in the background: the triggering request never waits for them.
Each attempt is an HTTP `POST` to `url` with:

- body: the JSON text of `{ id, event, teamId, actorId, via, occurredAt, data }`, where `id` is the
  delivery id and the rest are the event's (section 0.8). Every attempt of a delivery sends
  exactly the same body bytes.
- headers: `content-type: application/json`, `x-tracker-event: <event>`,
  `x-tracker-delivery: <delivery id>`, `x-tracker-attempt: <1, 2, …>` and
  `x-tracker-signature: sha256=<hex>`, where `<hex>` is the lowercase hex HMAC-SHA256 of the
  exact body bytes keyed with the webhook's secret.

An attempt **succeeds** when the receiver answers any `2xx` status within `webhooks.timeoutMs`.
Anything else (another status, a connection error, a timeout) is a failure. The outcome is known
as soon as the response's status line and headers arrive: the attempt does not wait for, and is
not changed by, the response body. After failed attempt number `i` (1-based), the next attempt
starts `retryDelaysMs[i-1]` ms later (real timers, not the `now` clock); after
`1 + retryDelaysMs.length` failed attempts the delivery is `failed`.

The delivery record tracks this: `attempts` counts **finished** attempts (an attempt in flight
is not counted until its outcome is known); `status` is `pending`, then
`succeeded` or `failed`; `lastStatusCode` is the response status of the most recent attempt
(`null` before the first attempt and when that attempt got no response); `lastError` is `null`
when the most recent attempt got a response (any status), and a non-empty string when it ended
in a connection error or timeout. Delivery records live in memory only (they don't survive a restart).
Pending timers must not keep the process alive (`unref` them) and stop when the server closes.
Deleting a webhook cancels its pending attempts; deactivating it does not (deliveries already
created still run). Deliveries are created in queue order (section 0.8), so the deliveries list
shows them in the reverse of that order, but their attempts are independent: a receiver may get
them in any order, and only the `x-tracker-delivery` id ties a request to its delivery.

`POST /webhooks/:webhookId/test` creates a delivery for the event `ping` with
`data: { webhookId }`, `actorId` the caller and `via: null`, sent even when the webhook is
inactive and whatever its `events`; it answers `202` at once with the new delivery's id. It is
not an event of section 0.8 (no activity entry, no audit entry, no notification, no rule).

## 9. Rate limiting (`ratelimit`)

Every request authenticated with a valid credential counts against **that credential's** budget:
each session token and each API key has its own (two tokens of the same user have separate
budgets, and an API key's budget is separate from its owner's tokens). Public routes, unknown
routes and requests answered `401` are not counted and carry none of these headers.

- Windows are fixed: a request at time `now()` falls in window
  `start = floor(now() / windowMs) * windowMs`, which ends at `end = start + windowMs`.
- If the credential has already made `limit` counted requests in this window, the request answers
  `429 rate_limited` with no other effect and is **not** counted. Otherwise it is counted and
  handled normally, whatever its outcome (a request that then fails at step 3a or later still
  counts, and an idempotent replay counts).
- Every counted request's response and every `429` carry:
  - `x-ratelimit-limit`: `limit`
  - `x-ratelimit-remaining`: `limit` minus the requests counted in this window so far (this one
    included), `0` on a `429`
  - `x-ratelimit-reset`: `ceil(end / 1000)` (Unix seconds)
- A `429` also carries `retry-after`: `max(1, ceil((end - now()) / 1000))`.

Example: `limit: 2, windowMs: 60000`, clock fixed at `1000000`. The window is
`[960000, 1020000)`. Requests 1 and 2 answer normally with remaining `1` then `0`; request 3
answers `429` with `retry-after: 20` and `x-ratelimit-reset: 1020`. With the clock moved to
`1020000`, the credential has a fresh budget.

## 10. Persistence and migration (`persistence`, `migration`)

### 10.1 The data file (`persistence`)

- With `dataFile` set, the whole state is kept in that JSON file: users (with password hashes),
  tokens (with their issue times), API keys (section 12), teams with their plans, members,
  invitations, projects, boards, columns, cards (with each project's next card number and each
  card's pending due job), comments, custom fields, team labels, checklist items, dependencies,
  sprints, templates, recurrences (with their next run), rules and rule runs, notifications,
  notification settings, watchers, attachments (with their bytes), activity entries and card
  history, saved views, time entries and running timers, webhooks (with secrets) and the audit log.
  Rate-limit counters, delivery records and stored idempotent responses are not persisted.
  Without `dataFile`, keep everything in memory.
- The file is a JSON object whose top-level `version` is `2`. The rest of its layout is yours.
- **Durability.** Before the response to any successful state-changing request is sent, the file
  on disk already holds the new state, including everything its pipeline did and every scheduler
  job that ran before it. (No debounced or background writes.) Write atomically: write a
  temporary file in the same directory, then rename it over the data file, so the file is always
  complete, valid JSON.
- A new `createApp({ dataFile })` on the same path sees exactly the same state: users log in with
  the same passwords, unexpired tokens and API keys still work, ids, numbers, positions and
  timestamps are unchanged, the next card number continues where it stopped, and pending jobs
  run when they are due.
- A missing file means an empty state; the file is created on the first write. `createApp` itself
  does not create it: the first successful state-changing request (or the first scheduler job
  that changes something) does.
- `createApp` throws (synchronously) if the file is not valid JSON, or if its `version` is
  neither `1` nor `2`; the message includes `unsupported data version` in the second case.
- The file never contains a plain-text password or a plain-text API key secret.

### 10.2 Loading a 1.x file (`migration`)

If the file's `version` is `1` (the format of `fixtures/tracker-v1.json`), `createApp`:

1. copies the file byte for byte to `<dataFile>.v1.bak`;
2. converts the data to the 2.0 model with the rules in 10.3;
3. writes the converted state to `dataFile` as version `2`, before `createApp` returns.

### 10.3 The 1.x format and how each field converts

The 1.x file is `{ version: 1, savedAt, users, teams, projects, boards, cards, comments }`. All 1.x
timestamps are numbers (milliseconds since the epoch); convert each to an ISO string with
`new Date(ms).toISOString()`. `savedAt` is ignored. Every 1.x `id` is kept as the 2.0 id. Every
2.0 `updatedAt` starts equal to `createdAt`. Migration emits no events, appends no audit or
activity entries (except the card history below), creates no notifications and never enforces
quotas or WIP limits.

**users** `{ id, email, name, passwordHash, createdAt }`

- `email` is trimmed and lowercased.
- `passwordHash` is `scrypt$<saltHex>$<keyHex>`, where key =
  `crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64)` (Node's default scrypt cost).
  Migrated users must be able to log in with their 1.x password (you may keep this hash format or
  re-hash on a successful login).
- 1.x has no handles. Derive one per user, processing users in file order: take the part of the
  lowercased email before the `@`, replace every character outside `[a-z0-9_]` with `_`, cut it
  to 20 chars, and if it is shorter than 3 chars pad it on the right with `_` to 3. If that handle
  is already taken by an earlier user, try `base.slice(0, 20 - s.length) + s` for
  `s = "_2", "_3", …` until one is free, where `base` is the handle after cutting and padding.

**teams** `{ id, name, owner, members: [{ user, role, addedAt }], createdAt }`

- `plan` is the `defaultPlan` option.
- `owner` becomes the `owner`, with `joinedAt` = the team's `createdAt`. Each entry of `members`
  becomes a member with `joinedAt` = `addedAt`. 1.x roles map `manager` → `admin`,
  `editor` → `member`, `reader` → `viewer`. (The migrated members of a team are therefore
  listed owner first, then `members` in file order, as long as the 1.x `addedAt` values are not
  earlier than the team's `createdAt`, which holds for the fixture.)

**projects** `{ id, teamId, name, key, archived, createdAt }` → `description: ""`, other fields
as is.

**boards** `{ id, projectId, name, columns: string[], limits: { [columnName]: number }, createdAt }`

- Each name in `columns` becomes a column, positions in array order, with a new id.
  `wipLimit` = `limits[name]` if present, else `null`. `category` follows the rule for the
  `columns` of a created board (section 4): one column `todo`; otherwise first `todo`, last
  `done`, the rest `in_progress`.

**cards** `{ id, boardId, column, title, notes?, assignee, tags, due, order, creator, createdAt }`

- `columnId`: the column of the card's board whose name equals `column` exactly; if none does,
  the board's first column (position 0).
- `position`: within each 2.0 column, the cards that land there are sorted by `order` ascending
  (ties: file order) and numbered `0 .. n-1`.
- `description` = `notes`, or `""` when absent. `createdBy` = `creator`.
- `assigneeId` = `assignee` if that user is a member of the card's team with role `owner`,
  `admin` or `member` after the role mapping; otherwise `null`.
- `labels`: split `tags` on `,`, trim and lowercase each piece, drop empty pieces and pieces
  longer than 30 chars, remove duplicates, sort ascending, keep the first 10.
- `dueDate`: `due` is `null` or a timestamp; the `YYYY-MM-DD` of that instant in UTC. A
  migrated card gets a pending due job only if the start of its `dueDate` is later than `now()`
  at load.
- `number` and `key`: numbered per project from 1, in order of `createdAt` ascending (ties: file
  order); the project's next number is one more than the highest. `key` uses the project's key.
- `priority: "none"`, `points: null`, `sprintId: null`, `customFields: {}`, not archived, no
  checklist, no dependencies, no time entries, no watchers. `completedAt` is the card's
  `createdAt` if its column is a done column, else `null`.
- Card history (section 25) starts with one entry `{ fromColumnId: null, toColumnId, at }`, where
  `at` is the card's `createdAt`.

**comments** `{ id, cardId, author, text, replyTo, createdAt }`

- `body` = `text`, `authorId` = `author`, `deleted: false`.
- `parentId` = `replyTo` if that id is a comment on the same card; otherwise `null`.
- `mentions` are computed from `body` with the rules of section 6, against the migrated handles
  and the migrated team membership.

1.x has nothing else: tokens, API keys, webhooks, the audit log, activity, and every record of
sections 12 to 32 start empty (users log in again).

The fixture's users and their 1.x passwords:

| id | 1.x email | password |
| --- | --- | --- |
| `u1` | `Ada@Example.com` | `analytical-engine` |
| `u2` | `grace.hopper+tracker@example.com` | `compiler-1952` |
| `u3` | `ada@lovelace.test` | `difference-engine` |
| `u4` | `Jo@example.com` | `short-handle` |
| `u5` | `linus@example.com` | `kernel-hacker` |
| `u6` | `margaret.hamilton@apollo.example` | `apollo-guidance` |
| `u7` | `outsider@example.com` | `not-a-member` |

## 11. Audit log (`audit`)

An **audit entry** is `{ id, teamId, actorId, via, action, targetType, targetId, details, at }`.

| Route | Role | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /teams/:teamId/audit` | admin+ | `?action=&actorId=&limit=&cursor=` | `200 { items: <entry>[], nextCursor }` newest first | `400 invalid_query` |

Every change (section 0.8) in the table below appends exactly one entry to the audit log of the
team it happens in. Cascades add nothing; failed requests, reads, auth, `/me` routes (API keys,
notifications, settings, mentions, invitations listed for the caller), watching, webhook test
pings, the due job and imports' individual cards add nothing. `actorId` and `via` are the change's
(section 0.8); `at` is `now()` of the request or job. `fields` is the list of updatable field names
present in the `PATCH` body, sorted ascending.

| Change | `action` | `targetType` | `targetId` | `details` |
| --- | --- | --- | --- | --- |
| `POST /teams` | `team.created` | `team` | team id | `{}` |
| `PATCH /teams/:teamId` | `team.updated` | `team` | team id | `{ fields }` |
| `POST /teams/:teamId/transfer` | `team.transferred` | `team` | team id | `{ from, to }` (user ids) |
| `PUT /teams/:teamId/plan` | `team.plan_changed` | `team` | team id | `{ from, to }` (plans) |
| `POST /teams/:teamId/members` | `member.added` | `member` | user id | `{ role }` |
| `POST /invites/:token/accept` | `member.added` | `member` | user id | `{ role }` |
| `PATCH /teams/:teamId/members/:userId` | `member.role_changed` | `member` | user id | `{ from, to }` (roles) |
| `DELETE /teams/:teamId/members/:userId` | `member.removed` | `member` | user id | `{}` |
| `POST /teams/:teamId/invites` | `invite.created` | `invite` | invite id | `{ email, role }` |
| `DELETE /invites/:inviteId` | `invite.revoked` | `invite` | invite id | `{}` |
| `POST /teams/:teamId/projects` | `project.created` | `project` | project id | `{}` |
| `PATCH /projects/:projectId` | `project.updated` | `project` | project id | `{ fields }` |
| `DELETE /projects/:projectId` | `project.deleted` | `project` | project id | `{}` |
| `POST /projects/:projectId/import` | `project.imported` | `project` | project id | `{ created, updated }` |
| `POST /teams/:teamId/import` | `project.created` | `project` | new project id | `{ imported: true }` |
| `POST /projects/:projectId/boards` | `board.created` | `board` | board id | `{}` |
| `PATCH /boards/:boardId` | `board.updated` | `board` | board id | `{ fields }` |
| `DELETE /boards/:boardId` | `board.deleted` | `board` | board id | `{}` |
| `POST /boards/:boardId/columns` | `column.created` | `column` | column id | `{}` |
| `PATCH /columns/:columnId` | `column.updated` | `column` | column id | `{ fields }` |
| `DELETE /columns/:columnId` | `column.deleted` | `column` | column id | `{}` |
| `POST /columns/:columnId/cards`, `POST /templates/:templateId/cards`, a recurrence | `card.created` | `card` | card id | `{}` |
| `PATCH /cards/:cardId` | `card.updated` | `card` | card id | `{ fields }` |
| `PUT /cards/:cardId/fields/:fieldId`, `DELETE /cards/:cardId/fields/:fieldId`, `set_field` | `card.updated` | `card` | card id | `{ fields: ["customFields"] }` |
| `set_assignee`, `add_label`, `remove_label`, `set_priority` | `card.updated` | `card` | card id | `{ fields: [<the attribute>] }` |
| `POST /cards/:cardId/move`, `move_to_column` | `card.moved` | `card` | card id | `{ fromColumnId, toColumnId, position }` |
| `DELETE /cards/:cardId` | `card.deleted` | `card` | card id | `{}` |
| the trash purge | `card.purged` | `card` | card id | `{}` |
| `POST /cards/:cardId/archive`, `archive_card` | `card.archived` | `card` | card id | `{}` |
| `POST /cards/:cardId/restore` | `card.restored` | `card` | card id | `{}` |
| `POST /cards/:cardId/comments`, `add_comment` | `comment.created` | `comment` | comment id | `{}` |
| `PATCH /comments/:commentId` | `comment.updated` | `comment` | comment id | `{}` |
| `DELETE /comments/:commentId` | `comment.deleted` | `comment` | comment id | `{}` |
| `POST /teams/:teamId/webhooks` | `webhook.created` | `webhook` | webhook id | `{}` |
| `PATCH /webhooks/:webhookId` | `webhook.updated` | `webhook` | webhook id | `{ fields }` |
| `DELETE /webhooks/:webhookId` | `webhook.deleted` | `webhook` | webhook id | `{}` |
| `POST /webhooks/:webhookId/rotate-secret` | `webhook.secret_rotated` | `webhook` | webhook id | `{}` |
| `POST /projects/:projectId/fields` | `field.created` | `field` | field id | `{}` |
| `PATCH /fields/:fieldId` | `field.updated` | `field` | field id | `{ fields }` |
| `DELETE /fields/:fieldId` | `field.deleted` | `field` | field id | `{}` |
| `POST /teams/:teamId/labels` | `label.created` | `label` | label id | `{}` |
| `PATCH /labels/:labelId` | `label.updated` | `label` | label id | `{ fields }` |
| `DELETE /labels/:labelId` | `label.deleted` | `label` | label id | `{}` |
| `POST /labels/:labelId/merge` | `label.merged` | `label` | label id (the one merged away) | `{ into }` (label id) |
| `POST /cards/:cardId/checklist` | `checklist.item_created` | `checklist_item` | item id | `{}` |
| `PATCH /checklist/:itemId` | `checklist.item_updated` | `checklist_item` | item id | `{ fields }` |
| `DELETE /checklist/:itemId` | `checklist.item_deleted` | `checklist_item` | item id | `{}` |
| `POST /cards/:cardId/blockers` | `dependency.added` | `card` | card id (the blocked one) | `{ blockerId }` |
| `DELETE /cards/:cardId/blockers/:blockerId` | `dependency.removed` | `card` | card id (the blocked one) | `{ blockerId }` |
| `POST /projects/:projectId/sprints` | `sprint.created` | `sprint` | sprint id | `{}` |
| `PATCH /sprints/:sprintId` | `sprint.updated` | `sprint` | sprint id | `{ fields }` |
| `DELETE /sprints/:sprintId` | `sprint.deleted` | `sprint` | sprint id | `{}` |
| `POST /sprints/:sprintId/start` | `sprint.started` | `sprint` | sprint id | `{}` |
| `POST /sprints/:sprintId/complete` | `sprint.completed` | `sprint` | sprint id | `{ carryOverTo }` (sprint id or `null`) |
| `POST /sprints/:sprintId/cards`, `add_to_sprint` | `sprint.cards_added` | `sprint` | sprint id | `{ cardIds }` (the cards whose `sprintId` changed, in body order) |
| `DELETE /sprints/:sprintId/cards/:cardId` | `sprint.card_removed` | `sprint` | sprint id | `{ cardId }` |
| `POST /projects/:projectId/templates` | `template.created` | `template` | template id | `{}` |
| `PATCH /templates/:templateId` | `template.updated` | `template` | template id | `{ fields }` |
| `DELETE /templates/:templateId` | `template.deleted` | `template` | template id | `{}` |
| `POST /boards/:boardId/recurrences` | `recurrence.created` | `recurrence` | recurrence id | `{}` |
| `PATCH /recurrences/:recurrenceId` | `recurrence.updated` | `recurrence` | recurrence id | `{ fields }` |
| `DELETE /recurrences/:recurrenceId` | `recurrence.deleted` | `recurrence` | recurrence id | `{}` |
| `POST /teams/:teamId/rules` | `rule.created` | `rule` | rule id | `{}` |
| `PATCH /rules/:ruleId` | `rule.updated` | `rule` | rule id | `{ fields }` |
| `DELETE /rules/:ruleId` | `rule.deleted` | `rule` | rule id | `{}` |
| `POST /cards/:cardId/attachments` | `attachment.added` | `attachment` | attachment id | `{ sha256, size }` |
| `PATCH /attachments/:attachmentId` | `attachment.updated` | `attachment` | attachment id | `{ fields }` |
| `DELETE /attachments/:attachmentId` | `attachment.deleted` | `attachment` | attachment id | `{}` |
| `POST /teams/:teamId/views` | `view.created` | `view` | view id | `{}` |
| `PATCH /views/:viewId` | `view.updated` | `view` | view id | `{ fields }` |
| `DELETE /views/:viewId` | `view.deleted` | `view` | view id | `{}` |
| `POST /cards/:cardId/time-entries`, `POST /cards/:cardId/timer/stop` | `time.logged` | `time_entry` | entry id | `{ minutes }` |
| `DELETE /time-entries/:entryId` | `time.deleted` | `time_entry` | entry id | `{}` |

- `add_to_sprint` adds one card, so its `cardIds` has one id.
- A label rename or merge that rewrites rules, views, templates or recurrences adds only its own
  `label.updated` or `label.merged` entry (the rewrites are cascades).
- `?action=` and `?actorId=` filter exactly; values that match nothing give an empty list.
- The audit log is persisted (section 10) and deleted with its team. Migrated data starts with an
  empty log.

## 12. API keys (`apikeys`)

An **API key** is `{ id, name, scope, teamId, prefix, expiresAt, createdAt, updatedAt }`. Its
`secret` is returned only by create.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /me/api-keys` | any user | `{ name, scope, teamId?, expiresAt? }` | `201 <api key>` plus `secret` | `400 invalid_body` · `409 quota_exceeded` |
| `GET /me/api-keys` | any user | | `200 { items: <api key>[] }` the caller's keys, oldest first | |
| `GET /me/api-keys/:keyId` | the key's owner | | `200 <api key>` | `404 not_found` |
| `PATCH /me/api-keys/:keyId` | the key's owner | `{ name?, expiresAt? }` | `200 <api key>` | `400 invalid_body` |
| `DELETE /me/api-keys/:keyId` | the key's owner | | `204` | |

### 12.1 Fields

- `name`: trimmed, 1 to 100 chars.
- `scope`: `read`, `write` or `admin` (scopes are ordered `read` < `write` < `admin`). It never
  changes: a `PATCH` body containing `scope` or `teamId` answers `400 invalid_body`.
- `teamId`: `null` (default) or the id of a team the caller is a member of (else
  `400 invalid_body`). A key with a `teamId` is **team-restricted**.
- `expiresAt`: `null` (default, never expires) or a string `Date.parse` accepts whose instant is
  later than `now()` (else `400 invalid_body`); stored as `new Date(Date.parse(value)).toISOString()`.
  `PATCH` may set it to `null` or to such a string.
- `secret`: `trk_` followed by at least 32 characters from `[A-Za-z0-9]`. `prefix` is the first
  12 characters of the secret. Store only a hash of the secret (for example SHA-256).
- Every user may hold at most 20 keys: creating a 21st answers `409 quota_exceeded` with
  `details: { resource: "apiKeys", limit: 20, used: 20 }`.
- Another user's key id answers `404 not_found` on the three `:keyId` routes. Deleting a key
  revokes it at once.

### 12.2 Authenticating with a key

A key is sent the same way as a token: `Authorization: Bearer trk_…`. An unknown or deleted key,
or one whose `expiresAt` is not `null` and `now() >= Date.parse(expiresAt)`, answers
`401 unauthorized`. A key acts as its owner: the same user id (in `actorId`, `createdBy`,
`authorId`, …), the same visibility and the owner's role **at the time of the request**. A
team-restricted key behaves, everywhere, as if its owner were a member of no team other than
`teamId`: other teams and everything in them answer `404 not_found`, and the caller's lists
(`GET /teams`, `GET /me/mentions`, `GET /me/notifications`, `GET /me/notifications/unread-count`,
`GET /me/invites`, `GET /me/activity`) leave out everything of other teams; `GET /me/timer`
answers `{ "timer": null }` for a timer on a card of another team. A key keeps working when its owner leaves
its team; it then simply sees nothing of that team.

### 12.3 What a key may do (check 3a)

1. `403 api_key_not_allowed`: an API key may never call `POST /auth/logout`, `PATCH /me`,
   `POST /me/password`, any `/me/api-keys` route, or `POST /invites/:token/accept`; a team-restricted
   key may also not call `POST /teams`.
2. `403 insufficient_scope`: each route needs a scope. It needs `admin` when its **Role** column
   starts with `admin+` or is `owner`; otherwise `read` for `GET` routes and `write` for every
   other method. A key whose scope is lower than the route's answers `403 insufficient_scope`.

Both are checked before the path resources (step 5), so a `read` key gets `403
insufficient_scope` on `PATCH /cards/<unknown id>`. Session tokens skip this check entirely.

## 13. Plans and quotas (`plans`)

Every team is on one plan. A plan is a set of **limits** (`null` means no limit):

| Limit | `free` | `team` | `business` |
| --- | --- | --- | --- |
| `projects` | 3 | 20 | `null` |
| `cards` | 100 | 5000 | `null` |
| `members` | 5 | 50 | `null` |
| `webhooks` | 2 | 10 | `null` |
| `rules` | 3 | 50 | `null` |
| `recurrences` | 2 | 20 | `null` |
| `storageBytes` | 1048576 | 104857600 | `null` |

A team's **usage** counts, for the team: `projects` (archived ones included), `cards` (every card
of every project, archived projects and archived cards included), `members`, `webhooks`
(inactive ones included), `rules` (disabled ones included), `recurrences` (inactive ones
included), and `storageBytes`, the sum of the `size` of the **distinct** `sha256` values among the
team's attachments (section 24).

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /plans` | public | | `200 { items: [{ id, limits }] }` in the order `free`, `team`, `business` | |
| `GET /teams/:teamId/plan` | viewer+ | | `200 { plan, limits, usage }` | |
| `PUT /teams/:teamId/plan` | owner | `{ plan }` | `200 { plan, limits, usage }` | `400 invalid_body` · `409 downgrade_blocked` |

- `limits` and `usage` are objects with exactly the seven keys of the table, in its order.
- **Quota check.** A request that would create records counted by a limit, such that the usage
  after it would exceed the limit, answers `409 quota_exceeded` with
  `details: { resource, limit, used }`, where `resource` is the limit's name and `used` the usage
  before the request. Where it is checked is written in each route's **Errors** column. A request
  that adds no new bytes (an attachment whose `sha256` the team already stores) passes the
  `storageBytes` check whatever the usage.
- The same answer is used for the fixed limits that do not depend on the plan: 20 API keys per
  user (`apiKeys`, section 12), 30 custom fields per project (`fields`, section 15), 50 checklist
  items per card (`checklistItems`, section 17).
- `PUT /teams/:teamId/plan`: `plan` is `free`, `team` or `business` (else `400 invalid_body`).
  Setting the plan the team already has is checked first: it answers `200` and changes nothing,
  whatever the usage. Otherwise, if any usage is above the new plan's limit, it answers `409 downgrade_blocked` with
  `details: { resources }`, the names of those limits in table order, and changes nothing.
  The no-op appends no audit entry.
- Pending invitations do not count as `members`; section 30 says how they are limited.
- Quotas are never enforced on data that is already there: a downgrade is refused instead, and
  migration ignores quotas.

## 14. Idempotency keys (`idempotency`)

Every authenticated `POST` route accepts an `Idempotency-Key` request header. Other methods, and
the public routes (`POST /auth/register`, `POST /auth/login`), ignore it.

- The value must be 1 to 100 characters from `[A-Za-z0-9_.:-]`, else `400 invalid_header`
  (check 3b).
- When a `POST` carrying the header ends in a `2xx` response, the app stores, under the scope
  (user id, method, path without the query string, key): the response status, the exact response
  body bytes, the exact request body bytes, and the time `now()`. A response that is not `2xx`
  stores nothing.
- A later `POST` by the same user (with any of their credentials) with the same key and the same
  method and path, while the stored record is not expired (`now() < stored + idempotencyTtlMs`):
  - with the same request body bytes, is **replayed**: it answers the stored status and body
    bytes, plus the header `idempotency-replayed: true`, and has no other effect at all (no
    change, no pipeline, no audit, no events, no write). It is still counted by the rate limit,
    and the scheduler still ran before it (section 0.9).
  - with different request body bytes, answers `409 idempotency_conflict`.
- The same key used by another user, or on another method or path, is unrelated. An expired
  record is forgotten: the request runs normally and may store a new record.
- A replay answers what was stored, even if the state has changed since (the card may have been
  deleted).
- Stored records live in memory only (they don't survive a restart).

## 15. Custom fields (`fields`)

A **custom field** is `{ id, projectId, name, type, options, required, createdAt, updatedAt }`.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /projects/:projectId/fields` | admin+ | `{ name, type, options?, required? }` | `201 <field>` | `400 invalid_body` · `409 project_archived` · `409 field_name_taken` · `409 quota_exceeded` |
| `GET /projects/:projectId/fields` | viewer+ | | `200 { items: <field>[] }` oldest first | |
| `GET /fields/:fieldId` | viewer+ | | `200 <field>` | `404 not_found` |
| `PATCH /fields/:fieldId` | admin+ | `{ name?, options?, required? }` | `200 <field>` | `400 invalid_body` · `409 project_archived` · `409 field_name_taken` |
| `DELETE /fields/:fieldId` | admin+ | | `204` | `409 project_archived` |
| `PUT /cards/:cardId/fields/:fieldId` | member+ | `{ value }` | `200 <card>` | `400 invalid_body` · `400 invalid_field_value` · `409 project_archived` · `409 card_archived` |
| `DELETE /cards/:cardId/fields/:fieldId` | member+ | | `200 <card>` | `400 field_required` · `409 project_archived` · `409 card_archived` |

In the two `/cards/:cardId/fields/:fieldId` routes, a `fieldId` that is not a field of the card's
project answers `404 not_found` (step 5).

### 15.1 Definitions

- `name`: trimmed, 1 to 50 chars, unique within the project compared case-insensitively
  (`409 field_name_taken`, also on a `PATCH` to a name another field of the project holds).
- `type`: `text`, `number`, `date`, `select`, `multiselect`, `checkbox`, `user` or `url`. It never
  changes: a `PATCH` body containing `type` answers `400 invalid_body`.
- `options`: for `select` and `multiselect`, required: an array of 1 to 50 strings, each trimmed
  and then 1 to 50 chars, distinct after trimming (compared exactly), stored trimmed in the given
  order. For every other type it must be absent (else `400 invalid_body`) and is stored as `[]`;
  a `PATCH` with `options` on such a field answers `400 invalid_body`.
- `required`: a boolean, default `false`.
- At most 30 fields per project: the `fields` quota of section 13, checked after
  `field_name_taken`.

### 15.2 Values

A card's `customFields` maps field ids to values; a field without a value has no key. A value is
valid for its field's type when it is:

| Type | Valid value | Stored as |
| --- | --- | --- |
| `text` | a string, trimmed, then 1 to 500 chars | the trimmed string |
| `number` | a finite JSON number | the number |
| `date` | a `YYYY-MM-DD` date | the string |
| `select` | a string equal to one of `options` | the string |
| `multiselect` | a non-empty array of strings, each equal to one of `options` | de-duplicated, in `options` order |
| `checkbox` | a boolean | the boolean |
| `user` | the id of a current member of the team (any role) | the string |
| `url` | an absolute `http:` or `https:` URL, at most 2000 chars | the string |

- An invalid value, or a key that is not the id of a field of the card's project (whatever its
  value, `null` included), answers `400 invalid_field_value` with `details: { fieldId }`, the
  first such key in the order the keys appear in the body's `customFields` object. For `PUT`, an
  invalid `value` gives `details.fieldId` = the path's `fieldId` (an unknown path `fieldId` is
  `404 not_found`, above).
- In a create body, a key of a field of the project whose value is `null` is ignored. In a `PATCH` body, `null` removes the
  value. In `PUT`, `value` is required and may not be `null` (`400 invalid_body`; use `DELETE`).
- `PUT` sets one value and `DELETE` removes one; both are changes of the card (section 5:
  `updatedAt`, `card.updated` with `fields: ["customFields"]`) even when the value is the same as
  before or there was none. They answer the card.

### 15.3 Required fields

- On card create (and template instantiation, section 20, and recurrence runs, section 21),
  every required field of the project must have a value after the body is applied, else
  `400 field_required` with `details: { fieldId }`, the first missing one in field creation order.
- `PATCH /cards/:cardId` removing (`null`) the value of a required field, and
  `DELETE /cards/:cardId/fields/:fieldId` on a required field, answer `400 field_required` with
  that field's id.
- Making a field required checks nothing: existing cards without a value keep none.

### 15.4 Searching by field

`GET /teams/:teamId/search` (and saved views, section 26) take `field.<fieldId>=<value>`:

- If `<fieldId>` is not a field of a project of the team, the condition matches no card (and the
  value is not validated).
- `text`, `date`, `select`, `user`, `url`: the card's value equals the given string exactly.
- `number`: the given string must be non-empty with `Number(value)` finite (else
  `400 invalid_query`); the card's value equals that number.
- `multiselect`: the card's array contains the given string.
- `checkbox`: the given string is `true` or `false` (else `400 invalid_query`); `true` matches a
  value of `true`; `false` matches cards **of the field's project** whose value is `false` or
  unset.
- Only cards of the field's project can match. A repeated `field.<id>` must match every value
  given.

### 15.5 Changing and deleting fields (cascades)

- A `PATCH` of `options` replaces the list (validated as on create). Values that are no longer
  options are removed: a `select` value is unset; a `multiselect` array loses them and is unset if
  it becomes empty. The same applies to the `customFields` of the project's templates.
- Deleting a field removes its value from every card and template of the project, and disables
  every rule that references it (section 22.6).
- Neither changes any card's `updatedAt` or emits anything.

## 16. Team labels (`labels`)

The team label catalogue gives labels a color and lets admins rename, delete and merge a label
across the whole team at once. A **label** is `{ id, teamId, name, color, createdAt, updatedAt }`.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams/:teamId/labels` | admin+ | `{ name, color? }` | `201 <label>` | `400 invalid_body` · `409 label_taken` |
| `GET /teams/:teamId/labels` | viewer+ | | `200 { items: <label>[] }` by `name` ascending | |
| `PATCH /labels/:labelId` | admin+ | `{ name?, color? }` | `200 <label>` | `400 invalid_body` · `409 label_taken` |
| `DELETE /labels/:labelId` | admin+ | | `204` | |
| `POST /labels/:labelId/merge` | admin+ | `{ intoLabelId }` | `200 <label>` (the target, unchanged) | `400 invalid_body` |

- `name`: normalised like a card label (trimmed, lowercased, then 1 to 30 chars). Unique within
  the team (`409 label_taken`, also on a rename to a name another label of the team holds).
- `color`: `#` followed by 6 hex digits, any case, stored lowercase; default `#888888`.
- Creating a label changes no card. Card labels need not be in the catalogue.
- In everything below, "**everywhere in the team**" means: the `labels` of every card of the team
  (archived projects and archived cards included), of every template and every recurrence of the
  team, the label values of every rule of the team (conditions on `labels` and the `label` of
  `add_label` and `remove_label` actions, section 22), and the `label` values of every saved view
  of the team (section 26). Every rewrite is a cascade, done even inside archived projects;
  after a rewrite, a `labels` array is de-duplicated and sorted again.
- **Rename** (`PATCH` with a `name` different from the current one): the old name is replaced by
  the new one everywhere in the team.
- **Delete**: the label leaves the catalogue and its name is removed from the `labels` of every
  card, template and recurrence of the team and from every saved view's `label` values; every
  rule that uses the name is disabled (section 22.6), its definition unchanged.
- **Merge**: `intoLabelId` must be another label of the same team (else `400 invalid_body`). The
  merged label's name is replaced by the target's name everywhere in the team (rules included,
  not disabled), then the merged label is deleted from the catalogue.

## 17. Checklists (`checklists`)

A **checklist item** is `{ id, cardId, text, done, position, doneAt, doneBy, createdAt, updatedAt }`.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /cards/:cardId/checklist` | member+ | `{ text, position? }` | `201 <item>` | `400 invalid_body` · `409 project_archived` · `409 card_archived` · `409 quota_exceeded` |
| `GET /cards/:cardId/checklist` | viewer+ | | `200 { items: <item>[] }` by position | |
| `PATCH /checklist/:itemId` | member+ | `{ text?, done?, position? }` | `200 <item>` | `400 invalid_body` · `409 project_archived` · `409 card_archived` |
| `DELETE /checklist/:itemId` | member+ | | `204` | `409 project_archived` · `409 card_archived` |

- `text`: trimmed, 1 to 200 chars. Items are created with `done: false`, `doneAt: null`,
  `doneBy: null`.
- Positions work like column positions: `0 .. n-1` without gaps; create inserts at `position`
  (`0 .. n`, default `n`); `PATCH position` (`0 .. n-1`) moves the item; delete closes the gap.
- `done`: a boolean. Changing it from `false` to `true` sets `doneAt` = `now()` and `doneBy` =
  the caller; from `true` to `false` sets both to `null`; sending the current value changes
  neither (the item's `updatedAt` still changes, as on every successful `PATCH`).
- At most 50 items per card: the `checklistItems` quota of section 13.
- The card's `checklist` summary follows its items. Checklist changes never change the card's
  `updatedAt`.
- **`checklist.completed`** is emitted by a `PATCH` or `DELETE` of an item when, after it, the card
  has at least one item and all of them are done, and before it not all of the card's items were
  done (for a `DELETE`, the deleted item counted as one of them). Nothing else emits it.

## 18. Dependencies (`dependencies`)

A card can be **blocked by** other cards of the same team. A **dependency** is
`{ cardId, blockerId, createdAt }`: card `cardId` is blocked by card `blockerId`.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /cards/:cardId/blockers` | member+ | `{ blockerId }` | `201 <dependency>` | `400 invalid_body` · `409 project_archived` · `409 card_archived` · `409 dependency_exists` · `409 dependency_cycle` |
| `GET /cards/:cardId/blockers` | viewer+ | | `200 { items: <card>[] }` the cards blocking it, in the order the dependencies were created | |
| `GET /cards/:cardId/blocking` | viewer+ | | `200 { items: <card>[] }` the cards it blocks, in the order the dependencies were created | |
| `DELETE /cards/:cardId/blockers/:blockerId` | member+ | | `204` | `409 project_archived` · `409 card_archived` |

- `blockerId`: the id of a card of the same team (any project), not the card itself, else
  `400 invalid_body`. `project_archived` and `card_archived` apply when **either** card is in an
  archived project or archived.
- In `DELETE`, a `blockerId` that is not a blocker of the card answers `404 not_found` (step 5).
- `409 dependency_exists`: that dependency already exists.
- `409 dependency_cycle`: adding "A blocked by B" would close a cycle, which is the case exactly
  when A can be reached from B by following blocked-by links (B is blocked by …, which is blocked
  by A; B blocked by A directly included). `details: { path }` is the list of card ids from B to
  A, each blocked by the next, found by a breadth-first search from B that visits each card's
  blockers in the order those dependencies were created, stopping the first time A is reached.
  For example, with C blocked by A and B blocked by C, adding "A blocked by B" answers `path:
  [B, C, A]`.
- A blocker is **open** when its `completedAt` is `null` and it is not archived. A card's
  `blocked` is `true` while it has at least one open blocker. Section 5 says what a blocked card
  can't do.
- Both lists include archived cards. Dependencies emit no events (they are audited, section 11).

## 19. Sprints and velocity (`sprints`)

A **sprint** is

```
{ id, projectId, name, goal, startDate, endDate, state, startedAt, completedAt,
  committedPoints, completedPoints, createdAt, updatedAt }
```

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /projects/:projectId/sprints` | admin+ | `{ name, goal?, startDate, endDate }` | `201 <sprint>` | `400 invalid_body` · `409 project_archived` |
| `GET /projects/:projectId/sprints` | viewer+ | `?state=planned\|active\|completed\|all` (default `all`) | `200 { items: <sprint>[] }` by `startDate` ascending, then creation order | `400 invalid_query` |
| `GET /sprints/:sprintId` | viewer+ | | `200 <sprint>` | `404 not_found` |
| `PATCH /sprints/:sprintId` | admin+ | `{ name?, goal?, startDate?, endDate? }` | `200 <sprint>` | `400 invalid_body` · `409 project_archived` · `409 sprint_state` |
| `DELETE /sprints/:sprintId` | admin+ | | `204` | `409 project_archived` · `409 sprint_state` |
| `POST /sprints/:sprintId/start` | admin+ | | `200 <sprint>` | `409 project_archived` · `409 sprint_state` · `409 sprint_active` |
| `POST /sprints/:sprintId/complete` | admin+ | `{ carryOverTo? }` | `200 <sprint>` | `400 invalid_body` · `409 project_archived` · `409 sprint_state` |
| `POST /sprints/:sprintId/cards` | member+ | `{ cardIds }` | `200 { items: <card>[] }` the sprint's cards | `400 invalid_body` · `409 project_archived` · `409 sprint_state` |
| `DELETE /sprints/:sprintId/cards/:cardId` | member+ | | `204` | `409 project_archived` · `409 card_archived` · `409 sprint_state` |
| `GET /sprints/:sprintId/cards` | viewer+ | | `200 { items: <card>[] }` | |
| `GET /sprints/:sprintId/burndown` | viewer+ | | `200 { sprintId, days: [{ date, remaining }] }` | |
| `GET /projects/:projectId/velocity` | viewer+ | `?count=` (integer 1 to 20, default 3) | `200 { items: [{ sprintId, name, committedPoints, completedPoints }], average }` | `400 invalid_query` |

- `name`: trimmed, 1 to 100 chars. `goal`: a string of at most 500 chars, default `""`.
  `startDate`, `endDate`: dates with `endDate >= startDate` (else `400 invalid_body`; on `PATCH`,
  the pair after the change is checked).
- `state` is `planned` when created, then `active`, then `completed`. `startedAt` and
  `completedAt` are `null` until then. `committedPoints` is `null` until the sprint starts and
  `completedPoints` until it completes.
- `PATCH`: a completed sprint answers `409 sprint_state`; on an active sprint, a body with
  `startDate` or `endDate` different from the current value answers `409 sprint_state` (its `name`
  and `goal` may change, and sending the current dates is fine).
- **A completed sprint is frozen**: no card enters or leaves it by any route or action
  (`409 sprint_state` on the routes, `failed sprint_state` for `add_to_sprint`).
- `DELETE`: only a planned sprint (else `409 sprint_state`). Its cards get `sprintId: null`
  (cascade).
- `start`: the sprint must be planned (`409 sprint_state`) and the project may have no other
  active sprint (`409 sprint_active`). It becomes `active`, `startedAt` = `now()`, and
  `committedPoints` = the sum of `points` (`null` counting 0) of its non-archived cards.
- `complete`: the body is a JSON object (send `{}` for no carry-over). The sprint must be active
  (`409 sprint_state`). `carryOverTo` is `null` (default) or the id of another sprint of the same
  project whose state is `planned` (else `400 invalid_body`). `completedPoints` = the sum of
  `points` of its non-archived cards whose `completedAt` is not `null`; then every non-archived
  card of the sprint whose `completedAt` is `null` gets `sprintId` = `carryOverTo` (a cascade).
  It becomes `completed` with `completedAt` = `now()`. Completed cards keep their `sprintId`.
- `POST …/cards`: `cardIds` is a non-empty array of at most 100 distinct strings, each the id of
  a non-archived card of the sprint's project (else `400 invalid_body`). The sprint must be
  planned or active, and no listed card may be in a completed sprint (`409 sprint_state`). Each
  listed card not already in this sprint gets `sprintId` = this sprint (from no sprint or from
  another planned or active sprint), its `updatedAt` changes and it emits `card.updated` with
  `fields: ["sprintId"]`. Cards already in it are left alone. When no card changes, nothing
  happens (no audit entry). The answer lists the sprint's cards as `GET /sprints/:sprintId/cards`
  does.
- `DELETE …/cards/:cardId`: a card whose `sprintId` is not this sprint answers `404 not_found`
  (step 5); an archived card answers `409 card_archived`; a completed sprint answers
  `409 sprint_state`. The card gets `sprintId: null`, its `updatedAt`
  changes and it emits `card.updated` with `fields: ["sprintId"]`.
- `PATCH /cards/:cardId` with `sprintId` also moves a card between sprints (section 5); that is a
  card update, audited as `card.updated`.
- `GET /sprints/:sprintId/cards` lists its non-archived cards by `number` ascending.
- **Burndown.** `days` has one entry per date from `startDate` to `endDate` inclusive. For a date
  `D` after today, `remaining` is `null`; otherwise it is the sum of `points` (`null` counting 0)
  of the sprint's current non-archived cards whose `completedAt` is `null` or not earlier than the
  end of `D`.
- **Velocity.** The project's completed sprints, most recently completed first (by `completedAt`;
  ties: the later-created sprint first), the first `count` of them. `average` is the mean of
  their `completedPoints` as `Math.round(mean * 100) / 100`, or `null` when there are none.

## 20. Card templates (`templates`)

A **template** is

```
{ id, projectId, name, title, description, labels, priority, points, customFields, checklist,
  createdBy, createdAt, updatedAt }
```

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /projects/:projectId/templates` | admin+ | `{ name, title, description?, labels?, priority?, points?, customFields?, checklist? }` | `201 <template>` | `400 invalid_body` · `400 invalid_field_value` · `409 project_archived` |
| `GET /projects/:projectId/templates` | viewer+ | | `200 { items: <template>[] }` oldest first | |
| `GET /templates/:templateId` | viewer+ | | `200 <template>` | `404 not_found` |
| `PATCH /templates/:templateId` | admin+ | `{ name?, title?, description?, labels?, priority?, points?, customFields?, checklist? }` | `200 <template>` | `400 invalid_body` · `400 invalid_field_value` · `409 project_archived` |
| `DELETE /templates/:templateId` | admin+ | | `204` | `409 project_archived` · `409 template_in_use` |
| `POST /templates/:templateId/cards` | member+ | `{ columnId, title?, assigneeId?, dueDate?, position? }` | `201 <card>` | `400 invalid_body` · `400 invalid_assignee` · `400 field_required` · `409 project_archived` · `409 quota_exceeded` · `409 wip_limit_reached` |

- `name`: trimmed, 1 to 100 chars (not unique). `title`: trimmed, 1 to 200 chars.
  `description`, `labels`, `priority`, `points`: the card rules and defaults (section 5).
  `customFields`: values valid for the project's fields (section 15.2; `null` values are not
  allowed here, `400 invalid_body`), default `{}`; required fields are not checked. A `PATCH`
  with `customFields` replaces the whole object. `checklist`: an array of at most 50 strings, each
  trimmed and then 1 to 200 chars, default `[]`.
- **Placeholders.** When a card is made from a template (or by a recurrence, section 21), these
  exact strings in its title and description are replaced, everywhere they occur:
  `{{date}}` by today, `{{user}}` by the acting user's handle, `{{number}}` by the new card's
  `number`, `{{project}}` by the project's key. Anything else is kept as is. After the
  replacement the title is trimmed and cut to its first 200 chars, the description cut to 10000.
- **Instantiate** (`POST /templates/:templateId/cards`): `columnId` must be a column of a board
  of the template's project (else `400 invalid_body`); `title`, when given, replaces the
  template's title (card title rules, placeholders replaced too); `assigneeId`, `dueDate` and
  `position` follow the card rules. The new card takes `description`, `labels`, `priority`,
  `points` and `customFields` from the template, `sprintId: null`, then the required fields are
  checked (`400 field_required`). One checklist item per `checklist` entry is created on it, not
  done, in order. It is one change: one `card.created` event, one audit entry, and no
  `checklist.completed`.
- `DELETE`: a template that a recurrence uses answers `409 template_in_use`.

## 21. Recurring cards (`recurring`)

A **recurrence** creates a card on a schedule. It is

```
{ id, boardId, columnId, templateId, title, description, labels, assigneeId, priority, points,
  schedule, startDate, endDate, active, nextRunAt, lastRunAt, lastCardId, lastError,
  createdBy, createdAt, updatedAt }
```

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /boards/:boardId/recurrences` | admin+ | `{ columnId, schedule, startDate, endDate?, templateId?, title?, description?, labels?, assigneeId?, priority?, points?, active? }` | `201 <recurrence>` | `400 invalid_body` · `400 invalid_assignee` · `409 project_archived` · `409 quota_exceeded` |
| `GET /boards/:boardId/recurrences` | viewer+ | | `200 { items: <recurrence>[] }` oldest first | |
| `GET /recurrences/:recurrenceId` | viewer+ | | `200 <recurrence>` | `404 not_found` |
| `PATCH /recurrences/:recurrenceId` | admin+ | `{ columnId?, schedule?, startDate?, endDate?, title?, description?, labels?, assigneeId?, priority?, points?, active? }` | `200 <recurrence>` | `400 invalid_body` · `400 invalid_assignee` · `409 project_archived` |
| `DELETE /recurrences/:recurrenceId` | admin+ | | `204` | `409 project_archived` |
| `GET /recurrences/:recurrenceId/occurrences` | viewer+ | `?count=` (integer 1 to 50, default 5) | `200 { items: string[] }` | `400 invalid_query` |

### 21.1 Fields

- `columnId`: a column of this board (else `400 invalid_body`).
- **Content.** Exactly one of `templateId` and `title` is given (both or neither:
  `400 invalid_body`).
  - With `templateId` (a template of the board's project, else `400 invalid_body`), the card's
    content comes from the template at run time; `title`, `description`, `labels`, `priority`
    and `points` may not be given (`400 invalid_body`) and are stored as `null`.
  - Without it, `templateId` is `null`; `title` (trimmed, 1 to 200 chars), `description`,
    `labels`, `priority` and `points` follow the card rules and defaults (section 5).
  - `templateId` never changes (`PATCH` with it: `400 invalid_body`), and a `PATCH` of `title`,
    `description`, `labels`, `priority` or `points` on a recurrence with a template answers
    `400 invalid_body`.
- `assigneeId`: `null` (default) or a member+ of the team, as for cards (`400 invalid_assignee`).
- `schedule`: `{ frequency, interval?, time, weekdays?, dayOfMonth? }`:
  - `frequency`: `daily`, `weekly` or `monthly`. `interval`: an integer 1 to 365, default 1.
  - `time`: `"HH:MM"`, 24-hour, `00:00` to `23:59`, UTC.
  - `weekdays`: required when weekly and not allowed otherwise: a non-empty array of distinct
    integers 0 to 6 (0 is Sunday), stored sorted ascending.
  - `dayOfMonth`: required when monthly and not allowed otherwise: an integer 1 to 31.
  - A `PATCH` with `schedule` replaces the whole object.
  - The stored `schedule` always has the five keys: `interval` (1 when omitted), and `null` for
    `weekdays` and `dayOfMonth` where they don't apply.
- `startDate`: a date. `endDate`: `null` (default) or a date `>= startDate` (on `PATCH`, the pair
  after the change).
- `active`: a boolean, default `true`.
- `lastRunAt`, `lastCardId` and `lastError` start `null`. Runs never change `updatedAt`.

### 21.2 Occurrences

The occurrence **dates** of a schedule are:

- `daily`: `startDate` plus `k * interval` days, for `k = 0, 1, 2, …`
- `weekly`: let `M` be the Monday on or before `startDate`. Every date `d >= startDate` whose day
  of the week is in `weekdays` and whose whole number of weeks since `M`
  (`floor(days(d - M) / 7)`) is a multiple of `interval`.
- `monthly`: for `k = 0, 1, 2, …`, the month `k * interval` months after the month of
  `startDate`, on day `min(dayOfMonth, number of days in that month)`, if that date is
  `>= startDate`.

and, when `endDate` is set, only dates `<= endDate`. An occurrence's **instant** is the start of
its date plus `time`. `GET …/occurrences` lists, as ISO strings, the first `count` occurrence
instants later than `now()` (fewer when the schedule ends), whether the recurrence is active or
not.

`nextRunAt` is the first occurrence instant later than `now()`, or `null` when there is none or
the recurrence is inactive. It is computed on create and again whenever a request changes
`schedule`, `startDate`, `endDate` or `active`, and after every run.

### 21.3 Runs

A recurrence with a `nextRunAt` has a pending job at that instant (section 0.9). When it runs, it
tries to create **one** card, even if several occurrences were missed. The card is created at the
end of the recurrence's column, as if `POST /columns/:columnId/cards` had been called by the
recurrence's `createdBy`: content from the template (with its checklist, as instantiation does)
or from the recurrence, placeholders replaced (section 20, with the acting user's handle for
`{{user}}`), `assigneeId` from the recurrence, `dueDate: null`, `sprintId: null`. It fails, and
creates nothing, on the first of these that applies, which is recorded as `lastError`:

1. `forbidden`: the creator is no longer a member of the team with role `owner`, `admin` or
   `member`.
2. `project_archived`: the project is archived.
3. `quota_exceeded`: the `cards` quota.
4. `wip_limit_reached`: the column's WIP limit (section 5).
5. `invalid_assignee`: `assigneeId` is no longer a member+ of the team.
6. `field_required`: a required field of the project has no value.

After the attempt, `lastRunAt` = `now()`, `lastCardId` = the new card's id on success (unchanged
on failure), `lastError` = `null` on success or the code above, and `nextRunAt` is computed
again. A successful run is a change with `via: { "type": "recurrence", "recurrenceId" }`: it
emits `card.created` and appends a `card.created` audit entry, so rules run on the new card.
A failed run appends no audit entry and emits nothing.

- The `recurrences` quota (section 13) is checked on create.
- When the recurrence's column is deleted, the recurrence moves to the `moveTo` column if one was
  given, else it is deleted (cascades). Deleting its board deletes it.

## 22. Automation rules (`automation`)

A **rule** says: when this event happens to a card, and the card meets these conditions, do these
actions. It is `{ id, teamId, name, enabled, trigger, conditions, actions, createdBy, createdAt,
updatedAt }`. A **run** records one evaluation:
`{ id, ruleId, event, cardId, depth, status, error, actions: [{ type, status, error }], at }`.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams/:teamId/rules` | admin+ | `{ name, trigger, conditions?, actions, enabled? }` | `201 <rule>` | `400 invalid_body` · `409 quota_exceeded` |
| `GET /teams/:teamId/rules` | viewer+ | | `200 { items: <rule>[] }` oldest first | |
| `GET /rules/:ruleId` | viewer+ | | `200 <rule>` | `404 not_found` |
| `PATCH /rules/:ruleId` | admin+ | `{ name?, trigger?, conditions?, actions?, enabled? }` | `200 <rule>` | `400 invalid_body` |
| `DELETE /rules/:ruleId` | admin+ | | `204` | |
| `POST /rules/:ruleId/test` | admin+ | `{ cardId }` | `200 { matched, conditions: boolean[] }` | `400 invalid_body` |
| `GET /rules/:ruleId/runs` | admin+ | `?limit=&cursor=` | `200 { items: <run>[], nextCursor }` newest first | `400 invalid_query` |
| `GET /teams/:teamId/rule-runs` | admin+ | `?status=&limit=&cursor=` | `200 { items: <run>[], nextCursor }` newest first | `400 invalid_query` |

### 22.1 Rule fields

- `name`: trimmed, 1 to 100 chars. `enabled`: a boolean, default `true`. `createdBy`: the
  caller. The `rules` quota (section 13) is checked on create.
- A `PATCH` validates only the fields it contains; `trigger`, `conditions` and `actions` replace
  the whole value. A `PATCH` that sets `enabled: true` also checks that every project, column,
  field and sprint the rule references (section 22.6) still exists, else `400 invalid_body`.
- Deleting a rule deletes its runs.

**`trigger`**: `{ event, projectId?, toColumnId?, fields? }`, always returned with all four keys
(`null` for a filter not given or not allowed for the event).

- `event`: `card.created`, `card.updated`, `card.moved`, `card.due`, `comment.created` or
  `checklist.completed`.
- `projectId`: `null` (default) or a project of the team (else `400 invalid_body`): only events
  whose card is in that project.
- `toColumnId`: allowed only with `card.moved` (else `400 invalid_body`); `null` (default) or a
  column of a board of the team: only moves whose `toColumnId` is that column.
- `fields`: allowed only with `card.updated` (else `400 invalid_body`); `null` (default) or a
  non-empty array of names from `title`, `description`, `assigneeId`, `labels`, `dueDate`,
  `priority`, `points`, `sprintId`, `customFields`, stored de-duplicated and sorted: only
  events whose `fields` contain at least one of them.
- An event's **card** is `data.card` for the card events and the comment's card for
  `comment.created`.

**`conditions`**: an array of at most 10 `{ field, op, value }` objects (default `[]`, which
always matches). All must hold. Each is checked against the card's **current** state when the
rule runs (not the event's snapshot):

| `field` | `op` | `value` | Holds when |
| --- | --- | --- | --- |
| `title` | `contains`, `not_contains` | a non-empty string | the title contains (does not contain) it, compared case-insensitively |
| `labels` | `contains`, `not_contains` | a label (normalised as a card label) | the card's labels include (do not include) it |
| `assigneeId` | `eq`, `ne` | a string or `null` | `assigneeId` is (is not) exactly the value |
| `priority` | `eq`, `ne`, `gte`, `lte` | a priority | compared in the order `none` < `low` < `medium` < `high` < `urgent` |
| `points` | `eq`, `ne`, `gt`, `gte`, `lt`, `lte` | a valid points value, or `null` with `eq` and `ne` only | the comparison holds; any comparison other than `eq` / `ne` is false when the card's `points` is `null` |
| `columnId` | `eq`, `ne` | a column of a board of the team | the card's column is (is not) it |
| `category` | `eq`, `ne` | a category | the card's column's category is (is not) it |
| `dueDate` | `is_set`, `is_not_set` | absent | `dueDate` is not (is) `null` |
| `blocked` | `eq` | a boolean | `blocked` equals it |
| `customFields.<fieldId>` | see below | see below | see below |

For `customFields.<fieldId>`, `<fieldId>` is a field of a project of the team (else
`400 invalid_body`). The ops are `is_set` and `is_not_set` (no `value`) for every type; `eq` and
`ne` for every type except `multiselect`; `contains` and `not_contains` for `multiselect`; and
`gt`, `gte`, `lt`, `lte` for `number` and `date` (dates compare as strings). `value` must be a
valid value for the field (section 15.2). A stored condition always has the three keys, with
`value: null` for `is_set` and `is_not_set`. A card with no value for the field (a card of another
project included) fails every op except `is_not_set`, `ne` and `not_contains`, which hold. Any
other `field`, an op not allowed for it, or a bad `value` is `400 invalid_body`.

**`actions`**: an array of 1 to 10 actions, run in order:

| `type` | Other keys | Effect, as a change by the rule's creator |
| --- | --- | --- |
| `set_assignee` | `userId`: a string or `null` | like `PATCH /cards/:cardId` with `assigneeId` |
| `add_label` | `label` | like `PATCH` adding that label to the card's labels |
| `remove_label` | `label` | like `PATCH` removing that label |
| `set_priority` | `priority` | like `PATCH` with `priority` |
| `move_to_column` | `columnId` | like `POST /cards/:cardId/move` to the end of that column |
| `set_field` | `fieldId`, `value` (a value, or `null` to remove it) | like `PUT` / `DELETE /cards/:cardId/fields/:fieldId` |
| `add_comment` | `body` | like `POST /cards/:cardId/comments` with that body (top level), placeholders replaced (below) |
| `notify` | `to`, `message` | creates `rule` notifications (section 23) |
| `add_to_sprint` | `sprintId`: a sprint id or `"active"` | like `POST /sprints/:sprintId/cards` with this card |
| `archive_card` | | like `POST /cards/:cardId/archive` |

Validation on create and `PATCH` (`400 invalid_body` when broken): `userId` is `null` or a team
member whose role is `owner`, `admin` or `member`; `label` is a label (normalised); `priority` a
priority; `columnId` a column of a board of the team; `fieldId` a field of a project of the team
and `value` `null` or valid for it (section 15.2); `body` trimmed, 1 to 5000 chars; `to` a
non-empty array of distinct entries, each `"assignee"`, `"watchers"`, `"creator"` or the id of a
team member; `message` trimmed, 1 to 500 chars; `sprintId` `"active"` or a sprint of a project of
the team; `archive_card` may only be the last action. In `add_comment` bodies and `notify`
messages, the placeholders of section 20 are replaced when the action runs (`{{user}}` is the
rule creator's handle, `{{number}}` the card's number), and so is `{{key}}`, by the card's key.
Actions are stored and returned with `type` and their own keys only, values normalised as the
target would store them (labels normalised, `body` and `message` trimmed, field values as in
section 15.2). A `PATCH` by another admin does not change `createdBy`: the rule keeps acting as
its creator.

### 22.2 When rules run

In step 2 of the pipeline (section 0.8), for an event whose depth is lower than
`automation.maxDepth`, every **enabled** rule of the event's team is considered, in rule creation
order:

1. If the trigger does not match the event, nothing happens (no run).
2. If the event's `via` is `{ "type": "rule", "ruleId": <this rule> }`, nothing happens (a rule
   never reacts to its own actions; it may react to another rule's).
3. Otherwise a run is recorded, with the event's name, its card's id, the event's depth and
   `at` = `now()`, and the first of these that applies decides it:
   1. The rule's creator is not a member of the team with role `owner` or `admin`: status
      `skipped`, error `forbidden`.
   2. The card no longer exists: `skipped`, `not_found`.
   3. The card's project is archived: `skipped`, `project_archived`.
   4. The card is archived: `skipped`, `card_archived`.
   5. A condition does not hold: status `no_match`, error `null`.
   6. Otherwise the actions run in order. Each ends `succeeded`, `noop` (nothing to change) or
      `failed` with an error code. At the first failure, the remaining actions are recorded as
      `not_run` with error `null`, and the run is `failed` with that error. Otherwise the run is
      `succeeded` with error `null`. Changes made by earlier actions stay.

   `actions` lists every action of the rule with its outcome when step 6 is reached, and is `[]`
   otherwise.

Each action that changes something is a change of section 0.8 (its `via` is
`{ "type": "rule", "ruleId", "runId" }`, its actor the rule's creator): audit entry, events
appended to the queue at depth + 1, `updatedAt` and every other effect of the route it mirrors,
including auto-watching (section 23) and the due job. Actions skip the role check, the rate limit
and idempotency.

### 22.3 Action outcomes

- `set_assignee`: `noop` when the card already has that `assigneeId`; `failed`
  `invalid_assignee` when `userId` is not `null` and not a current member+ of the team.
- `add_label`: `noop` when the card has the label; `failed` `invalid_body` when the card already
  has 10 labels. `remove_label`: `noop` when the card does not have it.
- `set_priority`: `noop` when equal.
- `move_to_column`: `failed` `not_found` when the column no longer exists or is not on the card's
  board; `noop` when the card is already in it; then `failed` `blocked`, then `failed`
  `wip_limit_reached`, by the rules of section 5.
- `set_field`, checked in this order: `failed` `not_found` when the field no longer exists or is
  not a field of the card's project; with `value: null`, `noop` when the card has no value, else
  `failed` `field_required` when the field is required; otherwise `failed` `invalid_field_value`
  when `value` is no longer valid (an option was removed, a user left), then `noop` when the card
  already has that (normalised) value, arrays compared element by element.
- `add_comment`: always changes something.
- `notify`: recipients are resolved when it runs: `"assignee"` the card's assignee (if any),
  `"watchers"` the card's watchers, `"creator"` the card's `createdBy`, an id that user; only
  current members of the team, each once, in the order of `to` (for `"watchers"`, in watching
  order). The notifications are created at once, when the action runs, not in step 4. The rule's
  creator is not left out. `noop` when nobody is left after this and after notification settings
  (section 23). `notify` appends no audit entry and emits no event. `rule` notifications are
  outside the one-per-event rule of section 23.2: each `notify` action notifies each of its
  recipients once, so two actions (or two rules) may notify the same user, and a watcher may get
  both a `rule` and a `moved` notification for the same move.
- `add_to_sprint`: with `"active"`, the active sprint of the card's project, `failed`
  `not_found` when there is none; with an id, `failed` `not_found` when that sprint no longer
  exists or is in another project, `failed` `sprint_state` when it is completed or the card is
  in a completed sprint. `noop` when the card is already in it. Its audit entry is `sprint.cards_added` with `cardIds: [<card id>]`.
- `archive_card`: archives the card (section 31).

### 22.4 Testing a rule

`POST /rules/:ruleId/test`: `cardId` must be a card of the team (else `400 invalid_body`). It
checks the rule's conditions against the card's current state and answers `conditions`, one
boolean per condition in order, and `matched`, whether all hold. The trigger and `enabled` are
ignored, nothing changes, and no run is recorded.

### 22.5 Runs

`GET /teams/:teamId/rule-runs` takes `?status=` (`succeeded`, `failed`, `skipped` or `no_match`,
else `400 invalid_query`). Runs are persisted and deleted with their rule.

### 22.6 References and disabling

A rule **references** the project of `trigger.projectId`; the columns of `trigger.toColumnId`,
of `columnId` conditions and of `move_to_column` actions; the fields of `customFields.<id>`
conditions and of `set_field` actions; the sprints of `add_to_sprint` actions (not `"active"`).
When a referenced project, column, field or sprint is deleted (directly or with what contains
it), the rule is disabled: `enabled` becomes `false` (a cascade; its definition is unchanged). A
team label deletion (section 16) disables the rules that use the label's name.

## 23. Notifications and watchers (`notifications`)

A **notification** is
`{ id, type, teamId, cardId, commentId, actorId, via, message, read, readAt, createdAt }`.
Notification **settings** are `{ types: { mention, comment, assigned, moved, due, rule, invite },
mutedProjectIds }`.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /me/notifications` | any user | `?unread=true\|false&teamId=&limit=&cursor=` | `200 { items: <notification>[], nextCursor }` newest first | `400 invalid_query` |
| `GET /me/notifications/unread-count` | any user | | `200 { count }` | |
| `POST /me/notifications/:notificationId/read` | the recipient | | `200 <notification>` | `404 not_found` |
| `POST /me/notifications/:notificationId/unread` | the recipient | | `200 <notification>` | `404 not_found` |
| `POST /me/notifications/read-all` | any user | `{ teamId? }` | `200 { updated }` | `400 invalid_body` |
| `DELETE /me/notifications/:notificationId` | the recipient | | `204` | `404 not_found` |
| `GET /me/notification-settings` | any user | | `200 <settings>` | |
| `PUT /me/notification-settings` | any user | `{ types, mutedProjectIds }` | `200 <settings>` | `400 invalid_body` |
| `POST /cards/:cardId/watch` | viewer+ | | `204` | |
| `DELETE /cards/:cardId/watch` | viewer+ | | `204` | |
| `GET /cards/:cardId/watchers` | viewer+ | | `200 { items: <member>[] }` in the order they started watching | |

### 23.1 Watchers

- `POST …/watch` makes the caller a watcher (no change if they already are); `DELETE …/watch`
  stops it (no change if they are not). Both answer `204`.
- A user starts watching a card automatically (as part of the change, only if they are not
  already watching) when they create it (for a recurrence, its creator; for a template, the
  caller; for a rule action, never), when it becomes assigned to them by any change, and when
  they comment on it (for `add_comment`, the rule's creator). When one change does two of these,
  the creator starts watching first, then the assignee. Imports create no watchers.
- Watchers are always current members of the card's team (section 2). Watching is not audited
  and emits nothing.

### 23.2 Which notifications are created

In step 4 of the pipeline, for each event, in this order of types:

| Type | For the event | Recipients |
| --- | --- | --- |
| `mention` | `comment.created` | every user in the comment's `mentions` |
| `comment` | `comment.created` | every watcher of the card who did not get a `mention` for this comment |
| `assigned` | `card.created` with a non-`null` `assigneeId`; `card.updated` whose change gave the card an `assigneeId` that is not `null` and differs from the one it had before | the assignee |
| `moved` | `card.moved` with `fromColumnId` ≠ `toColumnId` | every watcher of the card |
| `due` | `card.due` | the card's assignee, then every watcher of the card |

and, outside step 4: `rule` notifications when a `notify` action runs (section 22.3), and an
`invite` notification when an invitation is created for the email of a registered user (section
30).

**When recipients are read.** `mention` recipients are the event snapshot's `data.comment.mentions`;
the assignee of `assigned` and `due` is the snapshot's `data.card.assigneeId`; watchers and team
membership are read at step 4, that is after every rule of the pipeline has run (so a user who
started watching because a rule assigned the card to them gets that request's `comment` or
`moved` notification). For `assigned` on `card.updated`, "the one it had before" is the
`assigneeId` right before that change.

**Filtering**, applied in this order to the candidates of one event:

1. The event's actor never receives a notification for it (this does not apply to `rule`).
2. A recipient must be a current member of the team (not for `invite`).
3. A user receives at most one notification per event: the first type and position in the table
   that names them (after rules 1 and 2) wins, and recipients are notified in the order the
   table gives.
4. Then nothing is created for a recipient whose settings turn the winning type off, or (except
   for `invite`) whose `mutedProjectIds` contain the card's project. They get no other type for
   that event instead (a mentioned watcher who turned `mention` off gets no `comment` either).

Fields: `teamId` the team; `cardId` the event's card (`null` for `invite`); `commentId` the
comment for `mention` and `comment`, else `null`; `actorId` and `via` the event's (for `rule`,
the action's change; for `invite`, the inviter and `null`); `message` the `notify` message for
`rule`, else `null`; `read: false`, `readAt: null`, `createdAt` `now()`.

### 23.3 Reading

- The caller's notifications are **visible** while they are a member of the notification's team;
  `invite` notifications are always visible. Lists and counts only see visible ones; any other
  notification id (someone else's, or not visible) answers `404 not_found`.
- `?unread=true` lists only unread ones, `false` only read ones (any other value
  `400 invalid_query`). `?teamId=` narrows to one team (an id that matches nothing gives an empty
  list).
- `read` sets `read: true` and `readAt` = `now()` (an already read notification keeps its
  `readAt`); `unread` sets `read: false`, `readAt: null`.
- `read-all`: the body is a JSON object (send `{}` for all teams). `teamId`, when given, must be a team the caller is a member of (else
  `400 invalid_body`). Marks every visible unread notification (of that team only, if given) read
  with `readAt` = `now()`; `updated` is how many changed.
- Settings: the default is every type `true` and `mutedProjectIds: []`. `PUT` needs both keys:
  `types` an object with exactly the seven boolean keys (a missing or extra key is
  `400 invalid_body`), `mutedProjectIds` an array of at most 100 distinct strings, stored sorted
  ascending (they need not name existing projects). Settings never change existing
  notifications.
- Deleting a team deletes its notifications. Deleting a card keeps the notifications about it.

## 24. Attachments (`attachments`)

An **attachment** is
`{ id, cardId, filename, contentType, size, sha256, uploadedBy, createdAt, updatedAt }`.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /cards/:cardId/attachments` | member+ | raw bytes, `?filename=` | `201 <attachment>` | `400 invalid_query` · `400 invalid_body` · `409 project_archived` · `409 card_archived` · `409 quota_exceeded` |
| `GET /cards/:cardId/attachments` | viewer+ | | `200 { items: <attachment>[] }` oldest first | |
| `GET /attachments/:attachmentId` | viewer+ | | `200 <attachment>` | `404 not_found` |
| `GET /attachments/:attachmentId/content` | viewer+ | | `200` the bytes, or `304` | `404 not_found` |
| `PATCH /attachments/:attachmentId` | member+ | `{ filename }` | `200 <attachment>` | `400 invalid_body` · `409 project_archived` · `409 card_archived` |
| `DELETE /attachments/:attachmentId` | member+ | | `204` | `409 project_archived` · `409 card_archived` |

- **Upload.** The request body is the file, as raw bytes (any `content-type`; it is not parsed as
  JSON): 1 to 1048576 bytes (an empty body is `400 invalid_body`; a larger one is
  `413 body_too_large` at step 4). `filename` (query) is trimmed and must then be 1 to 255 chars
  with no `/`, no `\` and no character below U+0020 (else `400 invalid_query`); it is checked
  before the body. `contentType` is the request's `content-type` header up to its first `;`,
  trimmed and lowercased, or `application/octet-stream` when that is empty or the header is
  absent. `size` is the byte count, `sha256` the lowercase hex SHA-256 of the bytes, `uploadedBy`
  the caller.
- The `storageBytes` quota (section 13): the upload adds `size` bytes, or none when the team
  already stores an attachment with the same `sha256`.
- **Content.** `GET …/content` answers the exact bytes with `content-type: <contentType>`,
  `content-length` and `etag: "<sha256>"` (the hex in double quotes). When the request's
  `if-none-match` header is exactly that etag or `*`, it answers `304` with the `etag` header and
  no body.
- `PATCH`: `filename` by the upload's rule (`400 invalid_body` here).
- Deleting an attachment frees its bytes from `storageBytes` unless another attachment of the
  team has the same `sha256`.

## 25. Activity and card history (`activity`)

An **activity entry** is `{ id, teamId, projectId, cardId, event, actorId, via, data, at }`, one
per event (step 4 of the pipeline): `event`, `actorId`, `via` and `data` are the event's, `at` is
its `occurredAt`, `cardId` the event's card (`null` for member and sprint events), `projectId` the
project of the card, comment, attachment or sprint (`null` for member events).

A **history entry** is `{ fromColumnId, toColumnId, at }`.

| Route | Role | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /teams/:teamId/activity` | viewer+ | `?event=&actorId=&limit=&cursor=` | `200 { items: <entry>[], nextCursor }` newest first | `400 invalid_query` |
| `GET /projects/:projectId/activity` | viewer+ | `?limit=&cursor=` | `200 { items: <entry>[], nextCursor }` the entries with that `projectId`, newest first | `400 invalid_query` |
| `GET /cards/:cardId/activity` | viewer+ | `?limit=&cursor=` | `200 { items: <entry>[], nextCursor }` the entries with that `cardId`, newest first | `400 invalid_query` |
| `GET /me/activity` | any user | `?limit=&cursor=` | `200 { items: <entry>[], nextCursor }` the entries whose `actorId` is the caller, in teams the caller is a member of, newest first | `400 invalid_query` |
| `GET /cards/:cardId/history` | viewer+ | | `200 { items: <history entry>[] }` oldest first | |

- `?event=` and `?actorId=` filter exactly.
- **History** records where a card has been: one entry when it is created (`fromColumnId: null`,
  by any route, template, recurrence or import), and one for every move by the move route, the
  `move_to_column` action or a project import (`fromColumnId` = `toColumnId` for a move within a
  column), and for a restore (section 31). Cascades record nothing.
- Entries of a deleted card stay in the team and project feeds. Activity is deleted with its team.

## 26. Saved views (`views`)

A **saved view** is a named search, `{ id, teamId, name, query, shared, ownerId, createdAt,
updatedAt }`. A private view (`shared: false`) is visible only to its owner (anyone else gets
`404 not_found`); a shared view to every member of the team.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams/:teamId/views` | viewer+ (member+ when `shared` is `true`) | `{ name, query, shared? }` | `201 <view>` | `400 invalid_body` |
| `GET /teams/:teamId/views` | viewer+ | | `200 { items: <view>[] }` the caller's views and the team's shared views, oldest first | |
| `GET /views/:viewId` | viewer+ | | `200 <view>` | `404 not_found` |
| `PATCH /views/:viewId` | the owner, or admin+ when the view is shared; member+ to set `shared: true` | `{ name?, query?, shared? }` | `200 <view>` | `400 invalid_body` |
| `DELETE /views/:viewId` | the owner, or admin+ when the view is shared | | `204` | |
| `GET /views/:viewId/cards` | viewer+ | `?limit=&cursor=` | `200 { items: <card>[], total, nextCursor }` | `400 invalid_query` |

- `name`: trimmed, 1 to 100 chars. `shared`: a boolean, default `false`. `ownerId`: the creator.
- The role check (step 6) of `POST` and `PATCH` reads `shared` from the body: a `viewer` sending
  `shared: true` gets `403 forbidden`.
- `query`: an object whose keys are search parameters (section 7) with these value types:
  `q`, `projectId`, `boardId`, `columnId`, `assigneeId`, `dueFrom`, `dueTo`, `priority`,
  `sprintId`, `category`: strings; `label`: an array of strings; `blocked`, `includeArchived`:
  booleans; `fields`: an object mapping field ids to strings (the `field.<fieldId>` parameters).
  Every value must pass the search route's rule for that parameter (else `400 invalid_body`).
  Other keys are ignored and not stored. `label` values are stored trimmed and lowercased. A
  `PATCH` with `query` replaces it.
- `GET /views/:viewId/cards` answers exactly what `GET /teams/:teamId/search` answers for the
  stored query, called by the caller now, with the given `limit` and `cursor`.
- Label renames, merges and deletes rewrite stored queries (section 16). A condition on a deleted
  field stays and matches nothing.

## 27. Import and export (`exports`)

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /projects/:projectId/export` | viewer+ | `?format=json\|csv` (default `json`) | `200` the project document, or CSV text | `400 invalid_query` |
| `POST /projects/:projectId/import` | admin+ | `{ csv, dryRun? }` | `200 { created, updated, dryRun }` | `400 invalid_body` · `400 import_invalid` · `409 project_archived` · `409 quota_exceeded` |
| `POST /teams/:teamId/import` | admin+ | `{ document, key?, name? }` | `201 <project>` | `400 invalid_body` · `400 import_invalid` · `409 key_taken` · `409 quota_exceeded` |

### 27.1 The project document (JSON export)

```
{
  "format": "project-tracker/project",
  "version": 1,
  "project": { "name", "key", "description" },
  "fields": [ { "name", "type", "options", "required" } ],
  "boards": [ { "name", "columns": [ { "name", "category", "wipLimit" } ] } ],
  "cards": [ { "number", "board", "column", "position", "title", "description", "assignee",
               "labels", "dueDate", "priority", "points", "customFields", "checklist",
               "archived" } ]
}
```

Keys appear in exactly this order. `fields` and `boards` are in creation order, `columns` by
position, `cards` by `number` ascending (archived cards included). In a card, `board` is the
index of its board in `boards` and `column` the index of its column in that board's `columns`
(both 0-based); `position` is its position (`null` when archived); `assignee` is the assignee's
email or `null`; `customFields` maps field **names** to values, in field creation order, with
`user` values as the user's email; `checklist` is `[{ "text", "done" }]` by position.

### 27.2 CSV export

- The header row is `number,key,board,column,title,description,assignee,labels,dueDate,priority,points,archived`,
  then one column `field:<name>` per field, in field creation order. Then one row per card, by
  `number` ascending (archived cards included).
- Cells: `board` and `column` are names; `assignee` an email; `labels` and `multiselect` values
  joined with `;`; `checkbox` values `true` / `false`; `archived` `true` / `false`; numbers as
  `String(n)`; `user` values as emails; `null` and unset values as an empty cell.
- Encoding: cells separated by `,`, every row (the last included) ended by `\r\n`, no BOM. A cell
  is wrapped in double quotes when it contains `,`, `"`, `\r` or `\n`, or starts or ends with a
  space; inside quotes, `"` is written `""`. The response has
  `content-type: text/csv; charset=utf-8`.

### 27.3 Importing CSV into a project

`POST /projects/:projectId/import` takes `{ csv, dryRun? }`: `csv` a string, `dryRun` a boolean
(default `false`). The CSV is parsed with the encoding rules of 27.2 (rows may end with `\r\n` or
`\n`; one trailing line break is not a row). The first row is the header; every later row is a
**data row**, numbered from 1.

- **Header.** Every name must be one of the export's (`number`, `key`, `board`, `column`,
  `title`, `description`, `assignee`, `labels`, `dueDate`, `priority`, `points`, `archived`, or
  `field:<name>` naming a field of the project exactly), each at most once, else error
  `unknown_column` for that name. `board`, `column` and `title` must be present, else
  `missing_column` for each missing one. The `key` and `archived` columns are ignored. An empty
  `csv` (no header row) has every required column missing (`row: 0`); an unterminated quote in the
  header is `malformed` at `row: 0`.
- **Rows.** A row whose `number` cell is empty creates a card; a non-empty `number` must be the
  number of a card of the project, which the row updates (else `not_found`); the same number on
  two rows is `duplicate_row` on the later one. `board` names a board of the project (the first in
  creation order with exactly that name) and `column` a column of it (the first by position with
  exactly that name), else `not_found` (when the board is not found, the `column` cell is not
  checked). The other cells follow the card rules (`invalid_value`
  when broken): `title` is required, and the others use the empty cell for their default or for
  clearing (`null`, `[]`, `none`, no value); `assignee` is an email of a member+ of the team
  (`invalid_assignee`); `labels` and `multiselect` cells split on `;`; `points` a valid points
  value; `checkbox` `true` or `false`; `user` an email of a team member; `number` fields parsed
  with `Number` (finite). A created card that would miss a required field, and an update row
  whose empty cell would clear a required field, is `field_required` (on that field's column,
  `field:<name>`, or `null` when the column is absent).
- **Errors.** If any row has an error, nothing changes and the answer is `400 import_invalid` with
  `details: { errors: [{ row, column, code }] }`, every error, ordered by `row`, then by the
  column's place in the header (`field_required` after the other errors of its row; header
  errors are `row: 0`, in header order, then the missing columns in the order `board`, `column`,
  `title`). A row with a different number of cells than the header, or an unterminated quote,
  is the only error reported: `{ row, column: null, code: "malformed" }`, and parsing stops there.
- **Effect.** Rows are applied in row order. A created card goes to the end of its column; an
  updated row sets every column present in the header, and a row naming another board or column
  moves the card to the end of that column (so created and moved cards land in row order).
  A row for an **archived** card updates its other cells only: it is not moved and stays
  archived, whatever its `board` and `column` cells say (they must still resolve). WIP limits and
  `blocked` are not checked; a `dueDate` schedules the due job (section 5); `completedAt` and card history
  follow section 5 and section 25; updated cards' `updatedAt` changes. Then the `cards` quota is
  checked for the created cards (`409 quota_exceeded`, nothing imported). The answer gives the
  number of created and updated rows. An import emits no events and runs no rules; it appends one
  audit entry. With `dryRun: true` everything is checked the same way but nothing changes and no
  audit entry is appended.

### 27.4 Importing a project document into a team

`POST /teams/:teamId/import` creates a new project from a project document:

- First the body: `document` must be an object, and `key` and `name`, when given, follow the
  project rules (`400 invalid_body`). Then the document is checked (overridden values too).
- `document` is checked in document order (the key order of 27.1, array items in order), each
  value by this rule (a missing key counts as a broken value):
  - `format` is `"project-tracker/project"` and `version` is `1`;
  - `project.name`, `project.key`, `project.description`: the project rules (section 3);
  - each field: `name` by the field rules and unique among the document's fields
    (case-insensitively), `type` a field type, `options` as on field create for `select` and
    `multiselect` and exactly `[]` for every other type, `required` a boolean; at most 30 fields;
  - each board: `name` by the board rules, `columns` 1 to 20 items, each with `name` by the
    column rules, `category` a category, `wipLimit` `null` or 1 to 1000;
  - each card: `number` a positive integer, distinct among the cards; `board` and `column` valid
    indexes; `position` `null` when `archived` is `true`, else a non-negative integer; `title`,
    `description`, `labels`, `dueDate`, `priority`, `points` by the card rules; `assignee`
    `null` or a string; `customFields` an object whose keys are names of the document's fields
    and whose values are valid for those fields (section 15.2, with `user` values any string);
    `checklist` at most 50 items, each `{ text, done }` with `text` by the checklist rules and
    `done` a boolean; `archived` a boolean.

  Required fields and WIP limits are not enforced. The first broken value answers
  `400 import_invalid` with `details: { errors: [{ path, code: "invalid_value" }] }`, where `path`
  is the JSON Pointer of that value inside `document` (for example `/cards/3/title`).
- Then `409 key_taken` (for the key used), then the `projects` quota, then the `cards` quota for
  all the document's cards.
- The project gets the fields, boards with columns, and cards with their numbers (the next number
  is one more than the highest), labels, values and checklist items (done items get `doneAt` =
  `now()` and `doneBy` = the caller). In each column the non-archived cards are ordered by
  `position`, ties in document order, and numbered `0 .. n-1`. Archived cards are archived with
  `archivedAt` = `now()`. `createdBy` is the caller; `completedAt` follows the column;
  `sprintId` is `null`; each card gets one history entry and, for a future `dueDate`, a due job;
  no watchers are created. An
  `assignee` or `user` value whose email is not a member (member+ for `assignee`) of the team is
  dropped (`null` / no value).
- It emits no events, runs no rules, and appends one audit entry (`project.created` with
  `details: { imported: true }`).
- **Round trip.** Exporting the new project as JSON gives the imported document back, except for
  `project.key` and `project.name` when they were overridden and the dropped people.

## 28. Reports (`reports`)

All reports count only **non-archived** cards (section 31). "Open" means `completedAt` is `null`.

| Route | Role | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /projects/:projectId/reports/summary` | viewer+ | | `200 <summary>` | |
| `GET /projects/:projectId/reports/cycle-time` | viewer+ | `?from=&to=` | `200 { items, count, averageMs, medianMs, p85Ms }` | `400 invalid_query` |
| `GET /projects/:projectId/reports/flow` | viewer+ | `?from=&to=` (both required) | `200 { days: [{ date, todo, in_progress, done }] }` | `400 invalid_query` |
| `GET /projects/:projectId/reports/time` | viewer+ | `?from=&to=` | `200 { totalMinutes, byUser, byCard }` | `400 invalid_query` |
| `GET /teams/:teamId/reports/workload` | viewer+ | | `200 { items: [{ userId, openCards, openPoints, overdue }] }` | |

- **Summary** of the project's cards:
  `{ cards, byCategory: { todo, in_progress, done }, byPriority: { none, low, medium, high, urgent }, byAssignee: [{ assigneeId, open, done }], byLabel: [{ label, count }], overdue, blocked, points: { total, done } }`.
  `byCategory` counts by the category of each card's column; `byAssignee` has one entry per
  distinct `assigneeId` among the cards (`null` only when some card is unassigned; `[]` for a
  project without cards), `null` first, then ids ascending,
  with `open` and `done` (completed) counts; `byLabel` one entry per label used, ascending;
  `overdue` counts open cards whose `dueDate` is before today; `blocked` counts `blocked` cards;
  `points.total` sums `points` (`null` counting 0) and `points.done` those of completed cards.
- `from` and `to` are dates (else `400 invalid_query`), with `to >= from` when both are given
  (else `400 invalid_query`); absent means unbounded where allowed.
- **Cycle time.** For each completed card whose `completedAt` falls on a date from `from` to `to`:
  `startedAt` is the `at` of the first history entry (section 25) whose `toColumnId` is a column
  that exists and whose category is `in_progress` now, or the card's `createdAt` if there is none;
  `cycleTimeMs` = `Date.parse(completedAt) - Date.parse(startedAt)`, or 0 if that is negative.
  `items` are `{ cardId, key, startedAt, completedAt, cycleTimeMs }` by `completedAt`, ties by
  `number`. `count` is their number; `averageMs` `Math.round(mean)`; `medianMs` the middle value
  of the sorted `cycleTimeMs` (for an even count, `Math.round` of the mean of the two middle
  values); `p85Ms` the value at index `ceil(0.85 * count) - 1` of the sorted values. The three
  are `null` when `count` is 0.
- **Flow.** `from` and `to` are required (`400 invalid_query`), with at most 92 dates from `from`
  to `to`. For each date `D`, every card of the project created before the end of `D` is counted
  in the category of the column it was in at the end of `D`: the `toColumnId` of its last history
  entry whose `at` is before the end of `D`, with that column's current category (when that column
  no longer exists, the category of the card's current column).
- **Time.** The project's time entries (section 29) whose `date` is from `from` to `to`:
  `totalMinutes`; `byUser` `[{ userId, minutes }]` by `userId` ascending; `byCard`
  `[{ cardId, key, minutes }]` by card `number` (archived cards included here; only users and
  cards with entries).
- **Workload.** One item per team member whose role is `owner`, `admin` or `member`, in member
  order (`joinedAt`), counting the open cards assigned to them in non-archived projects of the
  team: `openCards`, `openPoints` (`null` counting 0), and `overdue` (as in the summary).

## 29. Time tracking (`time`)

A **time entry** is `{ id, cardId, userId, minutes, date, note, source, createdAt }`. A **timer**
is `{ cardId, startedAt }`.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /cards/:cardId/time-entries` | member+ | `{ minutes, date?, note? }` | `201 <time entry>` | `400 invalid_body` · `409 project_archived` · `409 card_archived` |
| `GET /cards/:cardId/time-entries` | viewer+ | | `200 { items: <time entry>[] }` oldest first | |
| `DELETE /time-entries/:entryId` | the entry's user, or admin+ | | `204` | |
| `POST /cards/:cardId/timer/start` | member+ | | `200 <timer>` | `409 project_archived` · `409 card_archived` · `409 timer_running` |
| `POST /cards/:cardId/timer/stop` | member+ | | `201 <time entry>` | `409 no_timer` |
| `GET /me/timer` | any user | | `200 { timer: <timer> \| null }` | |

- `minutes`: an integer 1 to 1440. `date`: a date not after today, default today. `note`: a string
  of at most 500 chars, default `""`. `userId` is the caller; `source` is `manual`.
- A user has at most one running timer, across all teams. `start` with a running timer anywhere
  answers `409 timer_running`; otherwise the timer starts at `now()`.
- `stop`: `409 no_timer` unless the caller's running timer is on this card. It creates an entry
  with `source: "timer"`, `date` = today, and `minutes` =
  `min(1440, max(1, Math.round((now() - startedAt) / 60000)))`, and the timer ends. Stopping works
  in archived projects and on archived cards.
- `DELETE /time-entries/:entryId`: being the entry's user is enough, whatever their current role
  (as for comments); anyone else needs admin+ (`403 forbidden`).
- The card's `minutesLogged` is the sum of its entries. Time entries emit no events; creating and
  deleting them is audited (section 11); timers are not.

## 30. Invitations (`invites`)

An **invitation** is
`{ id, teamId, email, role, status, expiresAt, invitedBy, createdAt, acceptedAt }`. Its `token` is
returned only by create.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams/:teamId/invites` | admin+ | `{ email, role }` | `201 <invitation>` plus `token` | `400 invalid_body` · `409 already_member` · `409 quota_exceeded` |
| `GET /teams/:teamId/invites` | admin+ | `?status=` | `200 { items: <invitation>[] }` oldest first | `400 invalid_query` |
| `DELETE /invites/:inviteId` | admin+ | | `204` | `409 invite_used` |
| `GET /me/invites` | any user | | `200 { items: <invitation>[] }` the pending invitations to the caller's email, oldest first | |
| `POST /invites/:token/accept` | the invitation's addressee | | `200 <member>` | `409 invite_used` · `409 invite_expired` · `409 already_member` · `409 quota_exceeded` |
| `POST /me/invites/:inviteId/decline` | the invitation's addressee | | `204` | `409 invite_used` · `409 invite_expired` |

- `email` by the rules of section 1, stored lowercased; `role` `admin`, `member` or `viewer`
  (else `400 invalid_body`). `409 already_member` when a member of the team has that email.
- `status` is `pending`, `accepted`, `declined` or `revoked`; a pending invitation whose
  `expiresAt` has passed (`now() >= Date.parse(expiresAt)`) is shown, filtered and treated as
  `expired`. `expiresAt` = `now() + invites.ttlMs`; `acceptedAt` is `null` until accepted. `token`
  is an opaque string of at least 32 chars.
- `?status=` is one of `pending`, `accepted`, `declined`, `revoked`, `expired`, `all` (default
  `all`; else `400 invalid_query`).
- **Quota.** On create, the team's members plus its pending (not expired) invitations, not
  counting a pending invitation to the same email, must be fewer than its `members` limit (else
  `409 quota_exceeded`, `resource: "members"`, with `used` that sum). On accept, the members alone
  must be fewer than the limit.
- Creating an invitation to an email that already has a pending (or expired) one in the team
  revokes the old one (a cascade). If a registered user has the email, they get an `invite`
  notification (section 23).
- **Addressee.** For `POST /invites/:token/accept`, step 5 looks the invitation up by `token`
  (unknown token: `404 not_found`; team membership is not needed to see it) and step 6 requires
  the caller's email to be the invitation's (`403 forbidden`). `decline` and `GET /me/invites`
  likewise concern the invitations to the caller's email; anyone else's `inviteId` answers
  `404 not_found`.
- **Accept**: an accepted, declined or revoked invitation answers `409 invite_used`, an expired one
  `409 invite_expired`. The caller becomes a member with the invitation's role (`joinedAt` =
  `now()`), the invitation becomes `accepted` with `acceptedAt` = `now()`, and `member.added` is
  emitted.
- **Decline** sets `declined`. **Revoke** (`DELETE`) sets `revoked` on a pending or expired
  invitation; an accepted, declined or revoked one answers `409 invite_used`.

## 31. Archive and trash (`trash`)

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /cards/:cardId/archive` | member+ | | `200 <card>` | `409 project_archived` · `409 card_archived` |
| `POST /cards/:cardId/restore` | member+ | `{ columnId?, position? }` | `200 <card>` | `400 invalid_body` · `409 project_archived` · `409 card_not_archived` · `409 wip_limit_reached` |
| `GET /projects/:projectId/trash` | viewer+ | `?limit=&cursor=` | `200 { items: <card>[], nextCursor }` archived cards, newest `archivedAt` first, ties by `number` descending | `400 invalid_query` |

- **Archive.** An archived card has `archived: true`, `archivedAt` = `now()` and `position: null`
  (the gap in its column closes). It keeps its `columnId`, sprint, labels, values, checklist,
  dependencies, watchers, attachments and time entries. Its `updatedAt` changes. A card already
  archived answers `409 card_archived`.
- **What archiving means elsewhere.** An archived card is left out of `GET /boards/:boardId/cards`,
  search and views, sprint card lists, burndown, velocity and commitment sums, reports, WIP
  counts and `column_not_empty`, and the HTML board page; it is never an open blocker. It is still
  returned by `GET /cards/:cardId`, the trash, the blockers and blocking lists and exports, and
  counts toward the `cards` quota until it is deleted.
- **Writes to an archived card** answer `409 card_archived`: `PATCH`, move, comment create /
  `PATCH` / `DELETE`, field values, checklist writes, dependencies (either card), attachment
  upload / `PATCH` / `DELETE`, time entry create, timer start, removal from a sprint and archive. `DELETE
  /cards/:cardId`, restore, watching and timer stop still work.
- **Restore.** The body is a JSON object (send `{}` for the defaults). `columnId` (default the
  card's `columnId`) must be a column of the card's board, and `position` an integer `0 .. n`
  (default `n`), else `400 invalid_body`. A card that is not archived answers
  `409 card_not_archived`; then the target column's WIP limit (section 5; any arriving card
  counts) answers `409 wip_limit_reached`. `blocked` is not checked. The card gets
  `archived: false`, `archivedAt: null`, the position, and the column; `completedAt` stays as it
  was if the target is a done column and it was not `null`, becomes `now()` if the target is a
  done column and it was `null`, and becomes `null` otherwise. A history entry from its previous
  `columnId` to the target is recorded.
- **Purge.** Each archived card has a pending trash purge job at
  `Date.parse(archivedAt) + trash.retentionMs`; restoring or deleting the card cancels it. When it
  runs, the card is deleted (whatever the state of its project, archived included) exactly as
  `DELETE /cards/:cardId` deletes it, with actor `null`, via
  `{ "type": "schedule" }`, the event `card.deleted` and the audit action `card.purged`.

## 32. HTML pages (`html`)

| Route | Role | Success |
| --- | --- | --- |
| `GET /html/boards/:boardId` | viewer+ | `200` the board page |
| `GET /html/cards/:cardId` | viewer+ | `200` the card page |
| `GET /html/projects/:projectId/summary` | viewer+ | `200` the summary page |
| `GET /html/me/notifications` | any user | `200` the notifications page |

- Pages answer `content-type: text/html; charset=utf-8`; errors are JSON as everywhere. They are
  authenticated like every other route (the `Authorization` header).
- Every page is `<!doctype html>` followed by `<html lang="en"><head><meta charset="utf-8"><title>…</title></head><body>…</body></html>`.
  Whitespace between tags is free. The elements and attributes below must appear exactly as
  given (attributes in the given order, values in double quotes); other markup may be added
  anywhere, but no other element may carry the `data-` attributes named here.
- **Escaping.** Every text value written into a page, as text or inside an attribute value, has
  `&`, `<`, `>`, `"` and `'` replaced by `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`, and
  nothing else replaced.
- **Board page.** Title: `<board name> · <project key>` (a space, U+00B7, a space). The body holds
  one `<section data-column-id="<id>" data-category="<category>">` per column, by position; each
  contains `<h2><column name></h2>` and a `<ul>` holding one
  `<li data-card-id="<id>" data-key="<key>">` per non-archived card of the column, by position.
  Each `li` contains `<span class="title"><title></span>`, then, when assigned,
  `<span class="assignee" data-user-id="<id>">@<handle></span>`, then one
  `<span class="label"><label></span>` per label in order.
- **Card page.** Title: `<key> <title>`. The body holds `<article data-card-id="<id>">`
  containing `<h1><title></h1>`, a `<dl>` with one `<dt>` and `<dd data-field="<name>">` pair for
  each of `column` (the column's name), `assignee` (`@<handle>`, or empty), `priority`, `points`
  (empty when `null`), `dueDate` (empty when `null`) and `labels` (joined with `, `), in this
  order, then `<div class="description">` with the description, each `\n` written as `<br>`
  after escaping, then `<ol class="comments">` holding the comment trees: one
  `<li data-comment-id="<id>">` per top-level comment, oldest first, containing
  `<p class="body"><body></p>` (for a deleted comment, `<p class="body"><em>deleted</em></p>`)
  and, when it has replies, an `<ol>` of its replies built the same way.
- **Summary page.** Title: `Summary · <project key>`. The body holds
  `<table data-report="summary">` with one `<tr data-category="<category>"><th><category></th><td><count></td></tr>`
  for each of `todo`, `in_progress`, `done` in this order, with the counts of the summary report
  (section 28).
- **Notifications page.** Title: `Notifications`. The body holds `<ul data-notifications="">`
  with one `<li data-notification-id="<id>" data-type="<type>" data-read="<true|false>">` per
  visible notification of the caller, newest first, at most 50.

---

## Done

Done means every route above behaves as written, `GET /health` still answers `{ "ok": true }`, a
1.x data file migrates as section 10 says, and `npm test` passes.
