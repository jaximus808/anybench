> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Errors

> ApiError — the one exception the client throws: the server's envelope, or a 2xx body the client cannot read.

Every non-2xx response throws `ApiError`. There is exactly one shape, and it is a transcription of the server's [error envelope](https://vetta.sh/docs/api/errors.md) — the client uses only the server's codes, so the two can never disagree. The client makes an `ApiError` itself in two cases: [an error body that is not the envelope](#an-error-body-that-is-not-the-envelope), and [a 2xx body it cannot read](#a-response-this-sdk-cannot-read).

## The `ApiError` class

```ts theme={"system"}
import { ApiError } from "@usenaive-sdk/managed-agents";
```

**status** `number`

The HTTP status, e.g. `404`.

**type** `string`

The error family from the envelope, e.g. `not_found`, `invalid_request`.

**code** `string`

The specific machine code, e.g. `validation_failed`, `subscription_required`, `insufficient_credits`.

**param** `string | undefined`

The offending field, when the server names one. This is what the CLI prints.

**requestId** `string`

The server's correlation id for this call — quote it in a bug report; it is the single most useful field.

**message** `string`

The human-readable message from the envelope.

## Catching

```ts theme={"system"}
import { ApiError } from "@usenaive-sdk/managed-agents";

try {
  await client.skills.get("skl_nope");
} catch (error) {
  if (error instanceof ApiError) {
    // error.status     404
    // error.type       "not_found"
    // error.code       "not_found"
    // error.param      the offending field, when the server names one
    // error.requestId  quote this in a bug report
  }
}
```

## An error body that is not the envelope

Something in front of the API (a proxy or the network edge) can answer with an HTML page or plain text instead of the JSON envelope. The client then picks the `code` from the HTTP status, using only codes from the server's taxonomy:

| Status | `code` |
| - | - |
| `400`, `413`, `415`, `422` | `validation_failed` |
| `401` | `unauthorized` |
| `403` | `forbidden` |
| `404` | `not_found` |
| `405` | `method_not_allowed` |
| `429` | `rate_limited` |
| `501` | `feature_not_configured` |
| `502`, `503`, `504` | `provider_error` (retry with backoff) |
| any other | `internal_error` |

The `message` is fixed, `HTTP <status>: the error response had no readable details`, and never quotes the page. A `403` is the exception: the API answers every `403` with the envelope, so a bare one was [blocked before it reached the API](https://vetta.sh/docs/api/errors.md#a-403-that-is-not-json), and the message says so. `requestId` is the `x-request-id` header when there is one, otherwise `""`.

## A response this SDK cannot read

A 2xx body that does not match the SDK's schema (an SDK older or newer than the API) throws `ResponseParseError`, a subclass of `ApiError`. It has the real `status` (a 2xx), `code: "internal_error"`, the `requestId`, and three more fields. Its status means the call **landed**: don't forward it as an HTTP status, and don't retry a write on it, or it runs twice. Check `instanceof ResponseParseError` before treating an `ApiError` as a refusal.

**method** `string`

The call's HTTP method.

**path** `string`

The call's path, e.g. `/v1/agents/agt_…`.

**issues** `ZodIssue[]`

What did not match, field by field. The message names the first three.

## What the client does not do

* **No retries.** A caller that wants retries owns that decision — the CLI and the dashboard want different policies. A `429` or `5xx` is thrown like any other error.
* **No code → status table.** `type` and `status` are read off the response. The server owns that mapping; a second copy here would be a second taxonomy that could drift.

## Errors worth planning for

| Code | Status | When |
| - | - | - |
| `validation_failed` | 400 | A body field is wrong; `param` names it. |
| `unauthorized` | 401 | The key is missing, revoked, or the token expired. |
| `forbidden` | 403 | The key lacks the scope the route requires. |
| `not_found` | 404 | Unknown id — or a real id in the other mode (`test` vs `live`). |
| `version_conflict` | 409 | e.g. `expected_version` on an agent update did not match. |
| `subscription_required` | 402 | The organization has no active plan. See [`credits.subscription`](https://vetta.sh/docs/sdk/credits#subscription). |
| `insufficient_credits` | 402 | The balance cannot cover the call. Top up first. |

The full catalogue lives in the [API error reference](https://vetta.sh/docs/api/errors.md).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.