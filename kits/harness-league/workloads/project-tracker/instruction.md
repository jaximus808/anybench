# Task: build the project tracker API

The repository in your working directory is the start of **project-tracker 2.0**, a multi-user
project tracker (think a small Trello or Linear) on plain `node:http`. Read its `README.md`. Today
it only answers `GET /health`. Build the whole application described below: accounts, teams with
roles, projects, boards and columns, cards, threaded comments with @mentions, search, outgoing
webhooks, rate limiting, persistence with a migration from the 1.x data format, and an audit log.

The application is graded by automated tests that call it over HTTP. They check every route,
field, status code and error code written here, so follow the contract exactly. Where this
document says "exactly", "in this order" or gives a formula, the tests depend on it.

## Ground rules

- No new dependencies. Use Node 22 built-ins only (`node:http`, `node:crypto`, `node:fs`,
  `node:path`, `node:test`, global `fetch`).
- `src/app.ts` must keep exporting `createApp(options?: AppOptions): http.Server`. It returns a
  server that is **not** listening yet; callers call `.listen()`. Keep `GET /health`. The
  `AppOptions` interface already in `src/app.ts` is the contract for options (section 0.6).
- `createApp` is synchronous. If `dataFile` is set it reads (and, for a 1.x file, migrates) the
  file before it returns.
- Two apps created in the same process share no state (tests create many apps side by side).
- Node runs the `.ts` files directly (type stripping): erasable TypeScript only, `.ts` import
  extensions.
- Organise the code however you like, but add your own tests under `test/` (`npm test` must pass).
  Test real behavior over HTTP.
- Do not edit `fixtures/tracker-v1.json`.

---

## 0. Conventions (apply to every route)

### 0.1 Requests and responses

- Request and response bodies are JSON (`content-type: application/json; charset=utf-8` on every
  response that has a body). `204` responses have no body.
- A request body larger than 64 KiB answers `413 body_too_large`. A body that is not valid JSON
  answers `400 invalid_json`. Where a route takes a body, the body must be a JSON object;
  anything else (missing, an array, a string) answers `400 invalid_body`. Routes that take no
  body ignore any body sent to them, and every route ignores query parameters it does not list.
  A listed query parameter sent with an empty value (`?limit=`) is present, not absent: it is
  checked by that parameter's own rule, so `?limit=`, `?cursor=`, `?archived=` and
  `?includeArchived=` answer `400 invalid_query` and an empty filter such as `?projectId=` or
  `?action=` matches nothing; only `q` treats a blank value as no condition (section 7).
- Unknown fields in a body are ignored. A known field with the wrong type or an out-of-range
  value answers `400 invalid_body`. "Trimmed" means leading and trailing whitespace is removed
  before the length check, and the trimmed value is what is stored.
- A `PATCH` body must contain at least one of the route's updatable fields, otherwise
  `400 invalid_body`.
- Unknown paths, and known paths with a method that is not listed, answer `404 not_found`.

### 0.2 Errors

Every error answers with its status and the body
`{ "error": { "code": "<code>", "message": "<human readable>" } }`. The complete list of codes:

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_body`, `invalid_query`, `invalid_assignee`, `wrong_password` |
| 401 | `unauthorized`, `invalid_credentials` |
| 403 | `forbidden` |
| 404 | `not_found`, `user_not_found` |
| 409 | `email_taken`, `handle_taken`, `already_member`, `owner_required`, `key_taken`, `project_archived`, `wip_limit_reached`, `column_not_empty`, `last_column`, `comment_deleted` |
| 413 | `body_too_large` |
| 429 | `rate_limited` |
| 500 | `internal` |

### 0.3 The order checks run in

When a request breaks several rules, the **first** failing check in this list decides the answer:

1. Route exists, else `404 not_found`.
2. Authentication (every route except `GET /health`, `POST /auth/register`, `POST /auth/login`),
   else `401 unauthorized`.
3. Rate limit (section 9), else `429 rate_limited`.
4. For routes that take a body: `413 body_too_large`, then `400 invalid_json`, then
   `400 invalid_body` if the body is not a JSON object (missing, an array, a string, …).
5. Every resource named in the **path** exists and the caller can see it, else `404 not_found`.
   A caller can see a team, and everything inside it, only while they are a member of that team
   (any role). Everything inside a team the caller is not a member of answers `404 not_found`,
   never `403`.
6. The caller's role allows the action (the **Role** column of each route), else `403 forbidden`.
7. Body and query validation: `400 invalid_body` / `400 invalid_query`, then checks on ids
   named in the body (`400 invalid_body`, `400 invalid_assignee`, `404 user_not_found`, as each
   route says).
8. State conflicts, the `409` codes: `project_archived` first, then the route's other `409`
   codes in the order its **Errors** column lists them.

### 0.4 Roles

A team member has exactly one role. From most to least powerful: `owner`, `admin`, `member`,
`viewer`. A role column entry such as "admin+" means `admin` or `owner`; "viewer+" means any
member. A team has exactly one `owner` at all times.

### 0.5 Ids, timestamps, ordering and pagination

- Ids are non-empty opaque strings, unique within their kind and never reused. Ids of records
  migrated from a 1.x file are kept (section 10.3); new ids must not collide with them.
- Timestamps are ISO-8601 strings produced by `new Date(now()).toISOString()`, where `now` is
  the clock option (section 0.6). Dates (`dueDate`, query filters) are `YYYY-MM-DD` strings
  naming a real calendar date (`2026-02-30` is invalid).
- **Creation order.** Lists without an explicit order are oldest first. Records migrated from a
  1.x file (section 10) always come before every record created after loading, whatever the
  timestamps (tests use small fake clocks). Within each of those two groups, records are sorted
  ascending by their timestamp (`createdAt`, `joinedAt`, `at`), ties broken by the order in
  which the server created them (for migrated records: the order of the 1.x file). This order is
  part of the state and survives a restart. "Newest first" is exactly the reverse.
- **Paginated lists** (search, mentions, audit log, deliveries) take `?limit=` (integer 1 to 100,
  default 20) and `?cursor=`, and answer `{ "items": [...], "nextCursor": string | null }` (search
  adds `total`). `nextCursor` is opaque; passing it back returns the next page. While the data
  does not change, following `nextCursor` from the first page visits every matching item exactly
  once, in order. It is `null` on the last page. A `limit` that is not an integer in range, or a
  `cursor` the server did not issue, answers `400 invalid_query`. A cursor belongs to the app that
  issued it: after a restart (a new `createApp` on the same `dataFile`), a cursor from before it
  answers `400 invalid_query`.
- Other lists answer `{ "items": [...] }` with every item.

### 0.6 Options

`createApp(options)` takes (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `dataFile` | none (memory only) | Path of the JSON data file (section 10). |
| `now` | `Date.now` | The clock in milliseconds since the epoch. Use it for **every** timestamp, token expiry and rate-limit window. Tests pass a fake clock and move it. |
| `tokenTtlMs` | `86400000` | Token lifetime (section 1). |
| `rateLimit` | `{ limit: 1000, windowMs: 60000 }` | Per-token rate limit (section 9). |
| `webhooks.retryDelaysMs` | `[1000, 5000, 30000]` | Wait before each retry (section 8). |
| `webhooks.timeoutMs` | `5000` | Time allowed for one delivery attempt. |

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
- `login`: a body whose `email` or `password` is not a string answers `400 invalid_body`. An
  unknown email or a wrong password answers `401 invalid_credentials`. Success returns a new
  opaque token of at least 20 chars and `expiresAt` =
  `new Date(issuedAt + tokenTtlMs).toISOString()`, where `issuedAt` is `now()` at login. A user may hold
  many tokens at once.
- Authenticated routes take `Authorization: Bearer <token>`. A missing or malformed header, an
  unknown, revoked or expired token answers `401 unauthorized`. A token is expired when
  `now() >= issuedAt + tokenTtlMs`.
- `logout` revokes the token it was called with (only that one).
- `POST /me/password`: both fields are validated first (`currentPassword` must be a string,
  `newPassword` 8 to 200 chars, else `400 invalid_body`); then a wrong `currentPassword` answers
  `400 wrong_password`. On success the
  password changes and **every** token of the user is revoked, the calling one included.
- `PATCH /me` with a new handle affects only mentions written after the change.

## 2. Teams and roles (`teams`)

A **team** is `{ id, name, ownerId, createdAt, myRole }`, where `myRole` is the caller's role.
A **member** is `{ userId, email, name, handle, role, joinedAt }`.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams` | any user | `{ name }` | `201 <team>` (caller is `owner`) | `400 invalid_body` |
| `GET /teams` | any user | | `200 { items: <team>[] }` teams the caller belongs to, in creation order of the teams | |
| `GET /teams/:teamId` | viewer+ | | `200 <team>` | `404 not_found` |
| `PATCH /teams/:teamId` | admin+ | `{ name }` | `200 <team>` | `400 invalid_body` |
| `DELETE /teams/:teamId` | owner | | `204` | |
| `GET /teams/:teamId/members` | viewer+ | | `200 { items: <member>[] }` oldest `joinedAt` first | |
| `POST /teams/:teamId/members` | admin+ | `{ email, role }` | `201 <member>` | `400 invalid_body` · `404 user_not_found` · `409 already_member` |
| `PATCH /teams/:teamId/members/:userId` | admin+ | `{ role }` | `200 <member>` | `400 invalid_body` · `409 owner_required` |
| `DELETE /teams/:teamId/members/:userId` | admin+, or any member removing themselves | | `204` | `409 owner_required` |
| `POST /teams/:teamId/transfer` | owner | `{ userId }` | `200 <team>` | `400 invalid_body` |

- Team `name`: a string, trimmed, 1 to 100 chars.
- Adding a member: `email` must pass the rules of section 1 (else `400 invalid_body`); it is
  then trimmed and matched case-insensitively against registered users (`404 user_not_found` if
  none); `role` is one of `admin`, `member`, `viewer` (`owner` or
  anything else is `400 invalid_body`). A user who is already a member is `409 already_member`.
- In `PATCH /teams/:teamId/members/:userId` and `DELETE …/members/:userId`, a `userId` that is not
  a member of the team answers `404 not_found`. `PATCH` sets `role` to `admin`, `member` or
  `viewer` (else `400 invalid_body`). Changing the owner's role, or removing the owner (even by
  the owner), answers `409 owner_required`. Admins may change the role of, or remove, any
  non-owner member, other admins included.
- A `member` or `viewer` calling `DELETE …/members/:userId` for someone else gets `403 forbidden`.
- When a user leaves or is removed, every card in the team assigned to them becomes unassigned
  (`assigneeId: null`), archived projects included. Their comments stay. Cascades (this one,
  cards moved by a column delete) never change any record's `updatedAt`.
- `transfer`: `userId` must name another member of the team (else `400 invalid_body`). The target
  becomes `owner`, the previous owner becomes `admin`, and `ownerId` changes. The response is the
  team as the caller now sees it (`myRole: "admin"`).
- Deleting a team deletes everything in it (projects, boards, cards, comments, webhooks, audit
  log). Its members simply stop seeing it.

## 3. Projects (`projects`)

A **project** is `{ id, teamId, name, key, description, archived, createdAt, updatedAt }`.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /teams/:teamId/projects` | admin+ | `{ name, key, description? }` | `201 <project>` (`archived: false`) | `400 invalid_body` · `409 key_taken` |
| `GET /teams/:teamId/projects` | viewer+ | `?archived=false\|true\|all` (default `false`) | `200 { items: <project>[] }` oldest first | `400 invalid_query` |
| `GET /projects/:projectId` | viewer+ | | `200 <project>` | `404 not_found` |
| `PATCH /projects/:projectId` | admin+ | `{ name?, description?, archived? }` | `200 <project>` | `400 invalid_body` |
| `DELETE /projects/:projectId` | admin+ | | `204` | |

- `name`: trimmed, 1 to 100 chars. `description`: a string of at most 2000 chars, default `""`.
  `archived`: a boolean.
- `key`: matches `^[A-Z][A-Z0-9]{1,5}$` exactly. Keys are unique within a team, archived projects
  included (`409 key_taken`). A key never changes: a `PATCH` body containing `key` answers
  `400 invalid_body`. Deleting a project frees its key, so a new project in the team may reuse it.
- `?archived=false` lists active projects, `true` only archived ones, `all` both.
- **Archived projects are read-only.** Every write to a board, column, card or comment inside an
  archived project answers `409 project_archived`. `PATCH` and `DELETE` of the project itself
  still work, so it can be renamed, unarchived or deleted.
- Deleting a project deletes its boards, columns, cards and comments.
- `updatedAt` changes on every successful `PATCH`.

## 4. Boards and columns (`boards`)

A **board** is `{ id, projectId, name, columns: <column>[], createdAt }`, with `columns` ordered
by `position`. A **column** is `{ id, boardId, name, position, wipLimit }`. Within a board,
column positions are always `0 .. n-1` with no gaps.

| Route | Role | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /projects/:projectId/boards` | admin+ | `{ name, columns? }` | `201 <board>` | `400 invalid_body` · `409 project_archived` |
| `GET /projects/:projectId/boards` | viewer+ | | `200 { items: <board>[] }` oldest first | |
| `GET /boards/:boardId` | viewer+ | | `200 <board>` | `404 not_found` |
| `PATCH /boards/:boardId` | admin+ | `{ name }` | `200 <board>` | `400 invalid_body` · `409 project_archived` |
| `DELETE /boards/:boardId` | admin+ | | `204` | `409 project_archived` |
| `POST /boards/:boardId/columns` | admin+ | `{ name, position?, wipLimit? }` | `201 <column>` | `400 invalid_body` · `409 project_archived` |
| `PATCH /columns/:columnId` | admin+ | `{ name?, position?, wipLimit? }` | `200 <column>` | `400 invalid_body` · `409 project_archived` |
| `DELETE /columns/:columnId` | admin+ | `?moveTo=<columnId>` | `204` | `400 invalid_query` · `409 project_archived` · `409 last_column` · `409 column_not_empty` |

- Board `name` and column `name`: trimmed, 1 to 50 chars. Column names need not be unique.
- `columns` on create: an array of 1 to 20 column names; default
  `["To do", "In progress", "Done"]`. They get positions in array order and `wipLimit: null`.
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
  be deleted (`409 last_column`); a column that still has cards answers `409 column_not_empty`
  unless `moveTo` was given, in which case its cards are appended to the end of that column,
  keeping their order, and the WIP limit is not checked. Remaining columns are renumbered without
  gaps.
- Deleting a board deletes its columns, cards and comments.

## 5. Cards (`cards`)

A **card** is

```
{ id, number, key, boardId, columnId, position, title, description,
  assigneeId, labels, dueDate, createdBy, createdAt, updatedAt }
```

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /columns/:columnId/cards` | member+ | `{ title, description?, assigneeId?, labels?, dueDate?, position? }` | `201 <card>` | `400 invalid_body` · `400 invalid_assignee` · `409 project_archived` · `409 wip_limit_reached` |
| `GET /boards/:boardId/cards` | viewer+ | `?columnId=` | `200 { items: <card>[] }` | `400 invalid_query` |
| `GET /cards/:cardId` | viewer+ | | `200 <card>` | `404 not_found` |
| `PATCH /cards/:cardId` | member+ | `{ title?, description?, assigneeId?, labels?, dueDate? }` | `200 <card>` | `400 invalid_body` · `400 invalid_assignee` · `409 project_archived` |
| `POST /cards/:cardId/move` | member+ | `{ columnId, position? }` | `200 <card>` | `400 invalid_body` · `409 project_archived` · `409 wip_limit_reached` |
| `DELETE /cards/:cardId` | member+ | | `204` | `409 project_archived` |

- `number` is the card's sequence number within its **project** (across all of the project's
  boards), starting at 1 and never reused, even after a card is deleted. `key` is
  `"<project key>-<number>"`, for example `"ENG-12"`. `createdBy` is the creator's user id.
- `title`: trimmed, 1 to 200 chars. `description`: a string of at most 10000 chars, default `""`.
- `assigneeId`: `null` (default) or a string. A value that is neither is `400 invalid_body`. A
  string that is not the id of a team member whose role is `owner`, `admin` or `member` (unknown
  id, not a member, a `viewer`) answers `400 invalid_assignee`.
  Later role changes don't touch existing assignments; leaving the team does (section 2).
- `labels`: an array of strings (default `[]`). Each label is trimmed and lowercased and must
  then be 1 to 30 chars. The stored value has duplicates removed and is sorted ascending
  (JavaScript default string order). The limit is on the result: more than 10 distinct labels
  after this normalisation is `400 invalid_body` (an array of 12 entries that reduces to 5 is
  fine).
- `dueDate`: `null` (default) or a `YYYY-MM-DD` date.
- **Positions.** Within a column, card positions are always `0 .. n-1` with no gaps, and every
  list of cards in a column is ordered by position. Creating a card inserts it at `position`
  (an integer `0 .. n`, default `n`, the end); later cards shift down by one. Deleting or moving a
  card out closes the gap.
- **Move.** `columnId` must be a column of the **same board** (else `400 invalid_body`).
  `position` is the index the card will have in the target column after the move: an integer
  from `0` to `k`, where `k` is the number of *other* cards in the target column (default `k`, the
  end). Moving within the same column reorders it. The relative order of all other cards never
  changes.
- **WIP limit.** Creating a card in, or moving a card into a **different** column whose
  `wipLimit` is not `null` and already holds `wipLimit` or more cards, answers
  `409 wip_limit_reached`. Reordering within a column is never blocked.
- `GET /boards/:boardId/cards` lists the board's cards ordered by column position, then card
  position. `?columnId=` narrows to one column; a column that is not on this board answers
  `400 invalid_query`.
- `updatedAt` changes on `PATCH` and on move of that card only (not when a neighbour shifts it).
- Deleting a card deletes its comments.

## 6. Comments and mentions (`comments`)

A **comment** is

```
{ id, cardId, parentId, authorId, body, mentions, deleted, createdAt, updatedAt, replies }
```

`replies` holds the comment's direct replies, oldest first, each a full comment with its own
`replies`, to any depth.

| Route | Role | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /cards/:cardId/comments` | member+ | `{ body, parentId? }` | `201 <comment>` (`replies: []`) | `400 invalid_body` · `409 project_archived` · `409 comment_deleted` |
| `GET /cards/:cardId/comments` | viewer+ | | `200 { items: <comment>[] }` top-level comments (`parentId: null`), oldest first, as trees | |
| `GET /comments/:commentId` | viewer+ | | `200 <comment>` (with its subtree) | `404 not_found` |
| `PATCH /comments/:commentId` | the author only | `{ body }` | `200 <comment>` | `400 invalid_body` · `409 project_archived` · `409 comment_deleted` |
| `DELETE /comments/:commentId` | the author, or admin+ | | `204` | `409 project_archived` · `409 comment_deleted` |
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
- A **mention** item of `GET /me/mentions` is `{ commentId, cardId, teamId, authorId, createdAt }`
  (the comment's `createdAt`). It lists every comment that currently has the caller in
  `mentions`, is not deleted, and belongs to a team the caller is still a member of. Leaving a team
  does not change any comment's `mentions`, so if the user rejoins, those comments are listed again.
- `updatedAt` changes on `PATCH` and on delete.

## 7. Search (`search`)

| Route | Role | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /teams/:teamId/search` | viewer+ | see below | `200 { items: <card>[], total, nextCursor }` | `400 invalid_query` |

Query parameters (all optional, combined with AND):

| Param | Meaning |
| --- | --- |
| `q` | Full-text query, at most 200 chars and at most 10 distinct terms (else `400 invalid_query`). Blank, absent, or with no terms after tokenizing (for example `!!!`) means no text condition. |
| `projectId`, `boardId`, `columnId` | Only cards in that project / board / column. An id that is not in this team simply matches nothing. |
| `assigneeId` | Only cards assigned to that user id; the literal `none` means unassigned cards. |
| `label` | May repeat (`?label=a&label=b`). Each value is trimmed and lowercased; the card must have **every** given label. |
| `dueFrom`, `dueTo` | `YYYY-MM-DD` (else `400 invalid_query`). Inclusive bounds on `dueDate`; when either is given, cards without a `dueDate` are excluded. |
| `includeArchived` | `true` or `false` (default `false`; anything else is `400 invalid_query`). Cards of archived projects are searched only when `true`. |
| `limit`, `cursor` | Pagination (section 0.5). |

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
| `POST /teams/:teamId/webhooks` | admin+ | `{ url, events, secret?, active? }` | `201 <webhook>` plus `secret` | `400 invalid_body` |
| `GET /teams/:teamId/webhooks` | admin+ | | `200 { items: <webhook>[] }` oldest first | |
| `GET /webhooks/:webhookId` | admin+ | | `200 <webhook>` | `404 not_found` |
| `PATCH /webhooks/:webhookId` | admin+ | `{ url?, events?, active? }` | `200 <webhook>` | `400 invalid_body` |
| `DELETE /webhooks/:webhookId` | admin+ | | `204` | |
| `POST /webhooks/:webhookId/rotate-secret` | admin+ | | `200 <webhook>` plus the new `secret` | |
| `POST /webhooks/:webhookId/test` | admin+ | | `202 { deliveryId }` | |
| `GET /webhooks/:webhookId/deliveries` | admin+ | `?limit=&cursor=` | `200 { items: <delivery>[], nextCursor }` newest first | `400 invalid_query` |

- `url`: an absolute `http:` or `https:` URL (tests use `http://127.0.0.1:<port>/…`).
- `events`: a non-empty array of event names from the list below, or containing `"*"` (all
  events). Stored de-duplicated and sorted ascending; any list containing `"*"` is stored as
  `["*"]`. Unknown names answer `400 invalid_body`.
- `secret`: a string of 16 to 200 chars; if omitted the server generates one of at least 32 chars.
  `active`: a boolean, default `true`.
- Rotating replaces the secret; later attempts are signed with the new one.
- `updatedAt` changes on every successful `PATCH` and on rotate-secret.
- `ping` is not a valid entry of `events` (it is only sent by the test route).

**Events.** Each successful request below emits exactly one event; nothing else emits events
(cascades such as a removed member's cards being unassigned emit nothing):

| Event | Emitted by | `data` |
| --- | --- | --- |
| `card.created` | `POST /columns/:columnId/cards` | `{ card }` |
| `card.updated` | `PATCH /cards/:cardId` | `{ card, fields }` (`fields`: the updatable field names present in the body, sorted) |
| `card.moved` | `POST /cards/:cardId/move` | `{ card, fromColumnId, toColumnId }` |
| `card.deleted` | `DELETE /cards/:cardId` | `{ card }` (as it was before deletion) |
| `comment.created` | `POST /cards/:cardId/comments` | `{ comment }` |
| `member.added` | `POST /teams/:teamId/members` | `{ member }` |
| `member.removed` | `DELETE /teams/:teamId/members/:userId` | `{ userId }` |

`card` and `comment` are the same objects the route returns.

**Delivery.** For each event, every **active** webhook of the team whose `events` match gets one
delivery, created with `status: "pending"`, `attempts: 0`. Attempts happen in the background:
the triggering request never waits for them. Each attempt is an HTTP `POST` to `url` with:

- body: the JSON text of `{ id, event, teamId, actorId, occurredAt, data }`, where `id` is the
  delivery id, `actorId` the user whose request emitted the event, `occurredAt` the event time.
  Every attempt of a delivery sends exactly the same body bytes.
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

`POST /webhooks/:webhookId/test` creates a delivery for the event `ping` with
`data: { webhookId }`, sent even when the webhook is inactive and whatever its `events`; it
answers `202` at once with the new delivery's id.

## 9. Rate limiting (`ratelimit`)

Every request authenticated with a valid token counts against **that token's** budget (two tokens
of the same user have separate budgets). Public routes, unknown routes and requests answered
`401` are not counted and carry none of these headers.

- Windows are fixed: a request at time `now()` falls in window
  `start = floor(now() / windowMs) * windowMs`, which ends at `end = start + windowMs`.
- If the token has already made `limit` counted requests in this window, the request answers
  `429 rate_limited` with no other effect and is **not** counted. Otherwise it is counted and
  handled normally.
- Every counted request's response and every `429` carry:
  - `x-ratelimit-limit`: `limit`
  - `x-ratelimit-remaining`: `limit` minus the requests counted in this window so far (this one
    included), `0` on a `429`
  - `x-ratelimit-reset`: `ceil(end / 1000)` (Unix seconds)
- A `429` also carries `retry-after`: `max(1, ceil((end - now()) / 1000))`.

Example: `limit: 2, windowMs: 60000`, clock fixed at `1000000`. The window is
`[960000, 1020000)`. Requests 1 and 2 answer normally with remaining `1` then `0`; request 3
answers `429` with `retry-after: 20` and `x-ratelimit-reset: 1020`. With the clock moved to
`1020000`, the token has a fresh budget.

## 10. Persistence and migration (`persistence`, `migration`)

### 10.1 The data file (`persistence`)

- With `dataFile` set, the whole state is kept in that JSON file: users (with password hashes),
  tokens (with their issue times), teams, members, projects, boards, columns, cards (with each
  project's next card number), comments, webhooks (with secrets) and the audit log. Rate-limit
  counters and delivery records are not persisted. Without `dataFile`, keep everything in memory.
- The file is a JSON object whose top-level `version` is `2`. The rest of its layout is yours.
- **Durability.** Before the response to any successful state-changing request is sent, the file
  on disk already holds the new state. (No debounced or background writes.) Write atomically:
  write a temporary file in the same directory, then rename it over the data file, so the file is
  always complete, valid JSON.
- A new `createApp({ dataFile })` on the same path sees exactly the same state: users log in with
  the same passwords, unexpired tokens still work, ids, numbers, positions and timestamps are
  unchanged, and the next card number continues where it stopped.
- A missing file means an empty state; the file is created on the first write. `createApp` itself
  does not create it: the first successful state-changing request does.
- `createApp` throws (synchronously) if the file is not valid JSON, or if its `version` is
  neither `1` nor `2`; the message includes `unsupported data version` in the second case.
- The file never contains a plain-text password.

### 10.2 Loading a 1.x file (`migration`)

If the file's `version` is `1` (the format of `fixtures/tracker-v1.json`), `createApp`:

1. copies the file byte for byte to `<dataFile>.v1.bak`;
2. converts the data to the 2.0 model with the rules in 10.3;
3. writes the converted state to `dataFile` as version `2`, before `createApp` returns.

### 10.3 The 1.x format and how each field converts

The 1.x file is `{ version: 1, savedAt, users, teams, projects, boards, cards, comments }`. All 1.x
timestamps are numbers (milliseconds since the epoch); convert each to an ISO string with
`new Date(ms).toISOString()`. `savedAt` is ignored. Every 1.x `id` is kept as the 2.0 id. Every
2.0 `updatedAt` starts equal to `createdAt`.

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

- `owner` becomes the `owner`, with `joinedAt` = the team's `createdAt`. Each entry of `members`
  becomes a member with `joinedAt` = `addedAt`. 1.x roles map `manager` → `admin`,
  `editor` → `member`, `reader` → `viewer`. (The migrated members of a team are therefore
  listed owner first, then `members` in file order, as long as the 1.x `addedAt` values are not
  earlier than the team's `createdAt`, which holds for the fixture.)

**projects** `{ id, teamId, name, key, archived, createdAt }` → `description: ""`, other fields
as is.

**boards** `{ id, projectId, name, columns: string[], limits: { [columnName]: number }, createdAt }`

- Each name in `columns` becomes a column, positions in array order, with a new id.
  `wipLimit` = `limits[name]` if present, else `null`. Migration never enforces WIP limits, so a
  column may start above its limit.

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
- `dueDate`: `due` is `null` or a timestamp; the `YYYY-MM-DD` of that instant in UTC.
- `number` and `key`: numbered per project from 1, in order of `createdAt` ascending (ties: file
  order); the project's next number is one more than the highest. `key` uses the project's key.

**comments** `{ id, cardId, author, text, replyTo, createdAt }`

- `body` = `text`, `authorId` = `author`, `deleted: false`.
- `parentId` = `replyTo` if that id is a comment on the same card; otherwise `null`.
- `mentions` are computed from `body` with the rules of section 6, against the migrated handles
  and the migrated team membership.

1.x has no tokens, webhooks or audit log: those start empty (users log in again).

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

An **audit entry** is `{ id, teamId, actorId, action, targetType, targetId, details, at }`.

| Route | Role | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /teams/:teamId/audit` | admin+ | `?action=&actorId=&limit=&cursor=` | `200 { items: <entry>[], nextCursor }` newest first | `400 invalid_query` |

Each successful request below appends exactly one entry (cascades add nothing; failed requests,
reads, auth and `/me` routes, and webhook test pings add nothing). `actorId` is the caller, `at`
the request time. `fields` is the list of updatable field names present in the `PATCH` body,
sorted ascending.

| Request | `action` | `targetType` | `targetId` | `details` |
| --- | --- | --- | --- | --- |
| `POST /teams` | `team.created` | `team` | team id | `{}` |
| `PATCH /teams/:teamId` | `team.updated` | `team` | team id | `{ fields }` |
| `POST /teams/:teamId/transfer` | `team.transferred` | `team` | team id | `{ from, to }` (user ids) |
| `POST /teams/:teamId/members` | `member.added` | `member` | user id | `{ role }` |
| `PATCH /teams/:teamId/members/:userId` | `member.role_changed` | `member` | user id | `{ from, to }` (roles) |
| `DELETE /teams/:teamId/members/:userId` | `member.removed` | `member` | user id | `{}` |
| `POST /teams/:teamId/projects` | `project.created` | `project` | project id | `{}` |
| `PATCH /projects/:projectId` | `project.updated` | `project` | project id | `{ fields }` |
| `DELETE /projects/:projectId` | `project.deleted` | `project` | project id | `{}` |
| `POST /projects/:projectId/boards` | `board.created` | `board` | board id | `{}` |
| `PATCH /boards/:boardId` | `board.updated` | `board` | board id | `{ fields }` |
| `DELETE /boards/:boardId` | `board.deleted` | `board` | board id | `{}` |
| `POST /boards/:boardId/columns` | `column.created` | `column` | column id | `{}` |
| `PATCH /columns/:columnId` | `column.updated` | `column` | column id | `{ fields }` |
| `DELETE /columns/:columnId` | `column.deleted` | `column` | column id | `{}` |
| `POST /columns/:columnId/cards` | `card.created` | `card` | card id | `{}` |
| `PATCH /cards/:cardId` | `card.updated` | `card` | card id | `{ fields }` |
| `POST /cards/:cardId/move` | `card.moved` | `card` | card id | `{ fromColumnId, toColumnId, position }` |
| `DELETE /cards/:cardId` | `card.deleted` | `card` | card id | `{}` |
| `POST /cards/:cardId/comments` | `comment.created` | `comment` | comment id | `{}` |
| `PATCH /comments/:commentId` | `comment.updated` | `comment` | comment id | `{}` |
| `DELETE /comments/:commentId` | `comment.deleted` | `comment` | comment id | `{}` |
| `POST /teams/:teamId/webhooks` | `webhook.created` | `webhook` | webhook id | `{}` |
| `PATCH /webhooks/:webhookId` | `webhook.updated` | `webhook` | webhook id | `{ fields }` |
| `DELETE /webhooks/:webhookId` | `webhook.deleted` | `webhook` | webhook id | `{}` |
| `POST /webhooks/:webhookId/rotate-secret` | `webhook.secret_rotated` | `webhook` | webhook id | `{}` |

- `?action=` and `?actorId=` filter exactly; values that match nothing give an empty list.
- The audit log is persisted (section 10) and deleted with its team. Migrated data starts with an
  empty log.

---

## Done

Done means every route above behaves as written, `GET /health` still answers `{ "ok": true }`, a
1.x data file migrates as section 10 says, and `npm test` passes.
