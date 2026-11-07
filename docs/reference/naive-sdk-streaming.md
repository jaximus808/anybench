> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Streaming

> client.stream — a resumable async generator over a session's events.

`client.stream(sessionId, options?)` is the one consumer of `GET /v1/sessions/{id}/stream`. It yields `Event` objects (the core `EventSchema`) as an async generator, reconnecting across dropped connections without gaps or duplicates.

## Signature

```ts theme={"system"}
stream(sessionId: string, options?: StreamOptions): AsyncGenerator<Event>
```

```ts theme={"system"}
import type { StreamOptions } from "@usenaive-sdk/managed-agents";
```

**afterSeq** `number`

Resume point. **Exclusive**: events with `seq > afterSeq` are delivered, so resuming from the last seq you saw does not replay it. Default `0` — from the beginning.

**maxRetries** `number`

Consecutive failed reconnects tolerated before the stream gives up. Default `5`.

**throughGrades** `boolean`

Default `true`: a `session.idle` that parks the session on its own [outcome](https://vetta.sh/docs/sdk/outcomes.md) grade (`stop_reason: "awaiting_delegation"` while an `outcome.evaluation.started` on this stream has no `completed` yet) does not end the stream, which runs on through the grade and any revision turn to the idle after a final result. `false` ends at the first `session.idle`.

## Consuming

```ts theme={"system"}
let last = 0;
for await (const event of client.stream(sessionId, { afterSeq: last })) {
  last = event.seq;
  console.log(event.type, event.seq);
}
```

Track `event.seq` as you go; if your process restarts, pass the last one back as `afterSeq` and the stream picks up exactly where it left off.

## Reading the agent's answer

`message.completed` carries **both** sides of the conversation: your own message is recorded as `{ role: "user", content }`, and the agent's reply is the same type without `role: "user"`. Filter on `role` and keep the last agent message of the turn:

```ts theme={"system"}
const session = await client.sessions.create({ agent_id: agentId, message: "Summarize the open tickets" });
let answer = "";
for await (const event of client.stream(session.id)) {
  if (event.type === "message.completed" && event.data.role !== "user") answer = String(event.data.content);
}
// The stream ended at session.idle: `answer` is the agent's final message of the turn.
```

For a follow-up, start after your send so the previous turn is not replayed: `const { accepted_seq } = await client.sessions.send(session.id, { message })`, then `client.stream(session.id, { afterSeq: accepted_seq })`. A user message with `from: "platform"` is a notice from the platform (a finished media job, say), not something you sent.

## Event types

Each event is `{ id, seq, type, session_id, data, created_at }`. The types a session's stream carries:

| Group | Types |
| - | - |
| Conversation | `message.delta` (a chunk of the agent's text, `content`), `message.completed` (a whole message, `content`; `role: "user"` for yours), `message.accepted` (a message you sent, waiting for its turn) |
| Tools | `tool.started`, `tool.completed`, `tool.confirm` (waiting on your approval), `tool.confirm.resolved`, `tool.confirm.answered` |
| Lifecycle | `session.running`, `session.idle` (carries `stop_reason`; the stream ends here), `session.usage`, `session.retrying`, `session.mode`, `session.degraded`, `session.computer_replaced`, `plan.updated`, `budget.exceeded` |
| Teams and grading | `thread.created`, `thread.running`, `thread.idle`, `thread.terminated`, `outcome.evaluation.started`, `outcome.evaluation.progress`, `outcome.evaluation.completed` |
| Background work | `media.job.queued`, `media.job.completed`, `media.job.failed`, `browser.session.opened`, `browser.session.closed`, `browser.context.saved` |
| Timing | `span.*.start` / `span.*.end` pairs (model requests and turn setup) |

Payloads for each are in the [event reference](https://vetta.sh/docs/api/events.md#event-types). New types are added over time; the stream skips a type your SDK version does not know rather than failing.

## Semantics worth knowing

* **Ends at `session.idle`.** The generator returns as soon as the session yields control — it does not wait for the server to close the socket, which stays open for its own keepalive window.
* **A resume on a settled session ends once caught up.** With `afterSeq > 0`, the stream first reads the session: if it is idle or ended, the generator delivers what is after `afterSeq` and returns at the session's last event (at once, yielding nothing, when there is nothing after it), even when that event is not a `session.idle`. A session that is working (including one with a message you just sent) is waited on as usual.
* **Reconnects on drops.** A closed connection without an idle event is retried on the same cursor, up to `maxRetries` consecutive failures. A delivered event resets the failure count.
* **Duplicates are impossible.** Anything at or below the cursor is dropped on the floor, so an overlapping replay after a reconnect never emits twice.
* **A 4xx is not a drop.** Client errors (except `429`) are the server's answer — they are thrown as [`ApiError`](https://vetta.sh/docs/sdk/errors) immediately rather than retried.
* **A grade park is not the end.** With `throughGrades` on (the default), the `session.idle` that parks a graded session on its own outcome grade does not end the generator; the idle after the grade's final result does.

## Polling instead

If SSE is awkward in your runtime, `sessions.events(id, { after_seq, limit })` reads the same log as pages, with the same exclusive cursor. By default it leaves out the opt-in types the stream always sends (`message.accepted`, `outcome.evaluation.*` and the other types listed under [`include_accepted`](https://vetta.sh/docs/api/events#list-events)); pass `includeAccepted: true` to get them. See [`sessions`](https://vetta.sh/docs/sdk/sessions#events).

## In a browser

Do not call `stream` from a browser: it would put the control-plane key in reachable memory. The dashboard re-serves the SSE body same-origin using the `send` escape hatch instead, so the key stays server-side.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.