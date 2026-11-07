# Naïve SDK 0.12.3: client behaviour that matters for packages/naive

Found while building TDM-13 ([1.7]) against `@usenaive-sdk/managed-agents@0.12.3`. No live calls:
everything below is from the installed `dist/index.js` / `dist/index.d.ts` and from mocked-`fetch`
tests (`packages/naive/test/tdm13-live-client.test.ts`).

## Ids are validated client-side

```sh
sed -n 1,10p packages/naive/node_modules/@usenaive-sdk/managed-agents/dist/index.js
```
```
var ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
var SUFFIX_LENGTH = 26;
var SUFFIX_PATTERN = new RegExp(`^[${ALPHABET}]{${SUFFIX_LENGTH},}$`);
function isId(prefix, value) { ... }
```

Every id is `<prefix>_` + at least 26 lowercase Crockford base32 chars (`ses_`, `agt_`, `evt_`, ...).
A response with `id: "ses_1"` throws `ResponseParseError` ("expected a ses_ id"). FakeNaive mints
ids in this shape (`ses_fake0000...`) so they survive any downstream check.

## Stream events that fail the schema are dropped silently

`streamEvents` does `if (!decoded.success) continue;`, so an event with a malformed id (or an
unknown `type`) never reaches the caller and nothing is thrown. A fixture with `id: "evt_1"`
produced an empty stream, not an error. Mocked SSE needs real-shaped event ids.

## Resume semantics

- `stream(id, { afterSeq })` is exclusive; with `afterSeq > 0` the SDK first calls
  `GET /v1/sessions/{id}` and, if the session is settled, returns once caught up to `last_seq`.
- It retries dropped connections itself (`maxRetries` 5) but throws 4xx (except 429) at once.
- `runSession` re-reads the log from 0 on a resume (to recover the final message and any
  `budget.exceeded`), but only passes events after `resume.afterSeq` to `onEvent`.

## Error codes

`../core/src/errors.ts` (inlined in dist) lists `budget_exceeded`, `insufficient_credits` and
`subscription_required` all as `quota` / 402. `mapNaiveError` maps each to its own class
(`NaiveBudgetExceededError`, `NaiveInsufficientCreditsError`, `NaiveSubscriptionRequiredError`).
A 2xx body the SDK cannot parse is `ResponseParseError` (the call landed): mapped to
`code: "response_unreadable"`, `retryable: false`, so a write is never retried on it.
