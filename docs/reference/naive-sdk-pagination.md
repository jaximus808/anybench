> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Pagination

> One page envelope on every list method, and no auto-paging iterator — deliberately.

Every `list` method answers the same envelope, parsed with `page(...)` from the core schemas:

```json theme={"system"}
{ "data": [ ... ], "has_more": true, "next_cursor": "agt_01H..." }
```

**data** `T[]`

One page of full objects, newest first.

**has\_more** `boolean`

Whether another page exists after this one.

**next\_cursor** `string | null`

Opaque cursor for the next page; `null` on the last page.

## The `ListQuery` type

```ts theme={"system"}
import type { ListQuery } from "@usenaive-sdk/managed-agents";
// { limit?: number | undefined; after?: string | undefined }
```

**limit** `number`

Page size. Server-side default and cap apply — see [Pagination](https://vetta.sh/docs/api/pagination.md).

**after** `string`

The `next_cursor` from the previous page. Exclusive.

`| undefined` is explicit on both so a caller can forward an unset CLI flag without a spread dance.

## Walking all pages

There is **no auto-paging iterator**. `list` returns one page and the cursor; the loop is yours:

```ts theme={"system"}
let after: string | undefined;
do {
  const page = await client.agents.list({ limit: 100, after });
  for (const agent of page.data) {
    // ...
  }
  after = page.next_cursor ?? undefined;
} while (after);
```

That is a decision, not a gap: an auto-pager hides the request count, and the two real consumers (the CLI and the dashboard) both want the page boundary visible.

## Filters ride the same query

List methods with filters extend `ListQuery` rather than replacing it, so `limit`/`after` always work:

* `sessions.list({ agent_id, status, stop_reason, deployment_id, parent_session_id, limit, after })`
* `files.list({ scope, session_id, limit, after })`
* `credits.ledger({ type, session_id, agent_id, deployment_id, from, to, limit, after })`
* `auditLogs.list({ actor, resource, action, from, to, limit, after })`

One exception of note: `skills.listVersions` pages on the **version number**, not an id — versions have no id of their own.

## Rows a list cannot read

`sessions.events`, `auditLogs.list`, `apps.artifacts.list` and `apps.companyTemplates.list` can meet rows newer than the SDK. Each one leaves a row it cannot read out of `data`, rather than failing the whole page, and counts it in `skipped: number`. On every other list, a row that does not match fails the call with a [`ResponseParseError`](https://vetta.sh/docs/sdk/errors#a-response-this-sdk-cannot-read).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.