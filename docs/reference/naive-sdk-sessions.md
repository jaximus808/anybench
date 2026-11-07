> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# sessions

> Run, steer, budget, and read back a task — client.sessions.

A session is one task run by an agent. Sixteen methods, one per route; objects parse with the core `SessionSchema`. API detail: [Sessions](https://vetta.sh/docs/api/sessions.md), [Events](https://vetta.sh/docs/api/events.md).

## create

```ts theme={"system"}
client.sessions.create(body: SessionCreate, opts?: { idempotencyKey?: string }): Promise<Session>
```

`POST /v1/sessions`. Creates **and** starts, with the initial message, in one call.

**agent\_id** `string` *required*

The agent to run.

**message** `string` *required*

The initial instruction.

**agent\_version** `number`

Pin an exact version; default is the agent's current one.

**window** `string`

[Completion window](https://vetta.sh/docs/concepts/completion-window.md) override: `immediate`, `priority` or `loose`. It sets the per-call price; a window the agent's model does not serve is `window_unavailable` (400).

**budget\_micro\_usd** `integer`

Spend cap for this session, integer micro-USD.

**identity** `string`

The persona this task acts as — an `idn_` id or the persona's name. Answered as `identity_id` on the session.

**output\_schema** `object`

JSON schema the final document must match.

**structured\_output\_required** `boolean`

Refuse a would-be clean ending that produced no document matching `output_schema`.

**outcome** `string`

An [outcome](https://vetta.sh/docs/sdk/outcomes.md) (`ocm_…`) to grade the session against from its first turn. An unknown one is `not_found` (404), and an agent that runs team members (any `handoffs` but `false`, or a `multiagent` roster) is `validation_failed` (400), before anything is quoted.

**deployment\_id** `string`

Set when a deployment fired this run.

**metadata** `object`

Arbitrary key/value pairs.

**mode** `string`

`plan` starts the session in [plan mode](https://vetta.sh/docs/concepts/session-operations.md#plan-mode); `build`, the default, does not.

```ts theme={"system"}
const session = await client.sessions.create({ agent_id: agent.id, message: "Reconcile August invoices" });
```

`create`, `send` and `handoffs` take an optional `{ idempotencyKey }`, sent as the `Idempotency-Key` header and recorded as the `client_message_id` of the message the call writes. Without one the client mints a fresh key per call, so a retry you make yourself is a second create or send; pass the same key to make it a replay of the first.

```ts theme={"system"}
const key = crypto.randomUUID();
const session = await client.sessions.create({ agent_id: agent.id, message: "Reconcile August invoices" }, { idempotencyKey: key });
```

## list

```ts theme={"system"}
client.sessions.list(query?: ListQuery & SessionFilter): Promise<Page<Session>>
```

`GET /v1/sessions`. `SessionFilter` adds `agent_id`, `status`, `stop_reason`, `deployment_id`, `parent_session_id` and `handoff_from` to the [page query](https://vetta.sh/docs/sdk/pagination.md). `handoff_from` is a session id and lists the top-level sessions that session [handed work to](#handoffs), newest first.

`stop_reason` is how you find the sessions a person has to answer. A session held on an `ask` tool call is `status: "idle"` like every finished one — what separates it is `stop_reason: "awaiting_approval"`, with the blocked call in `pending_actions`:

```ts theme={"system"}
const waiting = await client.sessions.list({ stop_reason: "awaiting_approval" });
for (const session of waiting.data) {
  for (const action of session.pending_actions) {
    // `action.args` is what is being approved.
    await client.sessions.confirmTool(session.id, { tool_call_id: action.tool_call_id, decision: "allow" });
  }
}
```

`stop_reason: "awaiting_answer"` is the same query for the sessions asking you a *question* rather
than for permission — see [`answer`](#answer). `"budget_paused"` is the same question asked about
money, and `"error"` about failure.

## get

```ts theme={"system"}
client.sessions.get(id: string): Promise<Session>
```

`GET /v1/sessions/{id}`. The single read also carries `outcome_evaluations[]`: every [outcome](https://vetta.sh/docs/sdk/outcomes.md) held over the session, oldest first, the last being the active one, each `{ object: "outcome_evaluation", session_id, outcome_id, result, iteration, explanation, attached_at }`. `result` is `pending` until the first grade lands. A session with no outcome carries `[]`; `sessions.list` does not join it.

```ts theme={"system"}
const session = await client.sessions.get(id);
const active = session.outcome_evaluations?.at(-1); // { outcome_id, result, iteration, explanation, … }
```

## operatorPreview

```ts theme={"system"}
client.sessions.operatorPreview(id: string, toolCallId: string): Promise<OperatorPreview>
```

`GET /v1/sessions/{id}/operator_preview?tool_call_id=…`. What an approval card shows for one parked `operator.request`, read from the account: `{ object: "operator_preview", tool_call_id, action, persona, title, verb, rows: { label, value }[], runnable, why }`. `why` says what stops it when `runnable` is `false`. See [Sessions](https://vetta.sh/docs/api/sessions.md).

## send

```ts theme={"system"}
client.sessions.send(id: string, body: { message: string; interrupt?: boolean; queue?: boolean; model?: string; mode?: "plan" | "build" }, opts?: { idempotencyKey?: string }): Promise<SendAccepted>
```

`POST /v1/sessions/{id}/messages`. Sending to a *running* session is refused with `session_running` unless you say which of two things you mean: `interrupt: true` steers it mid-run; `queue: true` holds the message in the session's inbox and it becomes the input of the turn that follows. On an idle session `queue` is a plain send. The two together are `validation_failed`. `model` runs the session on that model id from this message's turn on. The result's optional `hint` is set when the session was started for a board card that is now done or held by another session: the message went through, and the hint names the card and, when there is one, the session holding it.

## handoffs

```ts theme={"system"}
client.sessions.handoffs(id: string, body: SessionHandoffRequest, opts?: { idempotencyKey?: string }): Promise<HandoffBatch>

type SessionHandoffRequest = {
  agents: string[];            // 1–6, each an `agt_` id or an agent name
  message: string;
  handoff_key?: string;        // ≤ 128 chars; a repeat under a running key answers `already_running`
  budget_micro_usd?: number;   // cap under each receiver's own budget
};

type HandoffBatch = {
  object: "handoff_batch";
  handoffs: { object: "handoff"; agent_id: string; session_id: string; status: "queued" | "already_running"; handoff_key: string | null }[];
  refusals: { object: "handoff_refusal"; agent: string; code: string; message: string }[];
};
```

`POST /v1/sessions/{id}/handoffs`. Hands `message` from session `{id}` (the **sender**, a top-level session of yours) to each named agent, starting a top-level session per target marked `metadata.handoff = { from_session, from_agent, key, depth }`. Who may be named is the sender's agent's [`handoffs`](https://vetta.sh/docs/capabilities/tools#handoffs) policy — the same admission the model's `send_to_agent` goes through. A target that is refused is a **row** in `refusals`, not a thrown error; the batch resolves for the rest.

```ts theme={"system"}
const batch = await client.sessions.handoffs(root.id, {
  agents: ["trend-scout", "copywriter"],
  message: "Pull this week's numbers and draft the recap.",
  handoff_key: `room:${root.id}`,
});
// A member already on a room's key (`room:<id>`) gets no second session: the door says the words
// to the one it has. Such a session answers into the room, so it takes no `send` of yours.
for (const refusal of batch.refusals) console.warn(refusal.agent, refusal.code, refusal.message);
```

The work a session handed out is `client.sessions.list({ handoff_from: root.id })`; the work it delegated in-thread is [`threads`](#threads).

## threads

```ts theme={"system"}
client.sessions.threads(id: string, query?: ListQuery): Promise<Page<Session>>
```

`GET /v1/sessions/{id}/threads`. The child sessions a coordinator [delegated](https://vetta.sh/docs/team/delegation.md) from `{id}` with `send_to_agent` `wait: true` — `parent_session_id` is `{id}`, and they ran on its budget. A handoff (`wait: false`, or [`handoffs`](#handoffs) above) is *not* here: it is a top-level session of its own, found by `handoff_from`.

## interrupt

```ts theme={"system"}
client.sessions.interrupt(id: string, body?: { message?: string | null }): Promise<Session>
```

`POST /v1/sessions/{id}/interrupt`. Stops the current turn; an optional `message` tells the agent why. On a live session that is not running it changes nothing and returns the session as it was; on an ended one (`completed`, `failed`, `cancelled`) it is `session_terminal` (409).

## confirmTool

```ts theme={"system"}
client.sessions.confirmTool(id: string, body: { tool_call_id: string; decision: "allow" | "deny"; reason?: string; scope?: "call" | "session" }): Promise<Session>
```

`POST /v1/sessions/{id}/tool_confirmations`. Answers a session paused on a gated tool call. It
carries a verdict and no payload, so it cannot answer a *question* — that is `answer`, below, and
this route refuses a `kind: "question"` row rather than folding "allow" back at an agent that asked
for a mailbox address.

`scope` says how far the `allow` reaches. Omitted (or `"call"`) it approves this one call.
`"session"` grants the call's **tool** for the rest of that session — every later call to the same
tool name runs with no confirmation — and nothing else: one tool name, one session, gone when the
session ends, never written onto the agent, and never valid on a `deny`. For a call through the
tool invoker (`tools_execute`) the granted tool is the one named in its `tool` argument: the same
target runs with no confirmation, any other target through the invoker is still confirmed.

## answer

```ts theme={"system"}
client.sessions.answer(id: string, body: { tool_call_id: string; answers: Record<string, string | string[]> }): Promise<Session>
```

`POST /v1/sessions/{id}/answers`. Answers a session parked on a question it asked you.

A session with `stop_reason: "awaiting_answer"` carries a `kind: "question"` row in
`pending_actions`, holding the sentence the agent wrote and one to three fields. `answers` is keyed
by those fields' `key`s; a value is a string, or an array of them for a `multiple` choice:

```ts theme={"system"}
const asking = await client.sessions.list({ stop_reason: "awaiting_answer" });
for (const session of asking.data) {
  for (const action of session.pending_actions) {
    if (action.kind !== "question" || !action.question) continue;
    console.log(action.question.prompt);
    await client.sessions.answer(session.id, {
      tool_call_id: action.tool_call_id,
      answers: { mailbox: "hello@acme.com", tone: "warm" },
    });
  }
}
```

Every key the question asked for must be present — except one the question marked `optional`, which
is answered by leaving the key out entirely rather than by sending an empty string — and no other, so
a wake can never find the thing
the agent stopped for still missing. A `choice` answer is **not** limited to that field's `options`:
`other` defaults to `true` precisely so a person can say what the agent did not think of.

## cancel

```ts theme={"system"}
client.sessions.cancel(id: string): Promise<Session>
```

`POST /v1/sessions/{id}/cancel`. Terminal — the session cannot be resumed. Idempotent: an already cancelled session is returned as it is; a `completed` or `failed` one is `session_terminal` (409). There is no delete: cancel ends a session you are done with, and its record, cost and events are kept for the life of the organization.

## setBudget

```ts theme={"system"}
client.sessions.setBudget(id: string, capMicroUsd: number): Promise<Session>
```

`PATCH /v1/sessions/{id}/budget`, body `{ cap_micro_usd }`. **Raise only** — a cap at or below what is already consumed would be retroactive and is refused. Integer micro-USD.

## setOutcome

```ts theme={"system"}
client.sessions.setOutcome(id: string, body: { outcome: string }): Promise<OutcomeEvaluation>
```

`POST /v1/sessions/{id}/outcome`. Holds the session to an [outcome](https://vetta.sh/docs/sdk/outcomes.md); the next turn is graded. Answers the new evaluation at `result: "pending"`, `iteration: 0`, and replaces the active outcome, whose unfinished evaluation ends `interrupted`.

* **The session must be `idle`:** `session_running` (409) while it's running, queued or waiting on a grade; `session_terminal` (409) once it has ended.
* **The agent must work alone** (`handoffs: false`, no `multiagent` roster): `validation_failed` (400) otherwise. A team member's thread is refused too.
* **Judged by the session's own agent version.** A session keeps the version it started on, so changing the agent's `handoffs` afterwards does not change the answer for a session already running. To grade an agent you just switched to `handoffs: false`, start a new session.

`sessions.get` returns every evaluation as `outcome_evaluations[]`; the last is the active one.

## plan

```ts theme={"system"}
client.sessions.plan(id: string): Promise<Plan>
```

`GET /v1/sessions/{id}/plan`. The session's living plan, `version: 0` and empty until one is written. See [Plan mode](https://vetta.sh/docs/concepts/session-operations.md#plan-mode).

## writePlan

```ts theme={"system"}
client.sessions.writePlan(id: string, body: { markdown: string; base_version: number }): Promise<Plan>
```

`PUT /v1/sessions/{id}/plan`. The owner's edit, a compare-and-set: a stale `base_version` throws `ApiError` with `code: "version_conflict"`. It wakes nothing; the agent reads the edit next turn.

## events

```ts theme={"system"}
client.sessions.events(id: string, query?: { after_seq?: number; limit?: number; includeAccepted?: boolean }): Promise<Page<Event> & { skipped: number }>
```

`GET /v1/sessions/{id}/events` — the same log [`client.stream`](https://vetta.sh/docs/sdk/streaming) serves, read as pages. `after_seq` is **exclusive**, so polling with the last seq you saw never re-reads it.

`includeAccepted: true` also returns the opt-in types the list leaves out by default (`message.accepted`, `handoff.sent`, `tool.confirm.resolved`, `tool.confirm.answered`, `session.mode`, `plan.updated` and `outcome.evaluation.*`); see [Events](https://vetta.sh/docs/api/events.md#list-events).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.