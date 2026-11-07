> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# proxy

> One org-level model call, in the Messages or the Chat Completions format — client.proxy.

Four methods: two model calls through one [router](https://vetta.sh/docs/concepts/model-router.md#calling-the-router-directly), `messages` and `completions`, and two reads of what those calls did, [`calls`](#calls) and [`call`](#call). [`POST /v1/proxy/anthropic/v1/messages`](https://vetta.sh/docs/api/proxy) and [`POST /v1/proxy/openai/v1/chat/completions`](https://vetta.sh/docs/api/proxy#post-v1proxyopenaiv1chatcompletions) are compatibility endpoints: their whole point is that a client you already have works unchanged. These are the typed way to reach them from *this* client, for the case where you want one model call — any catalogue id, `vetta/auto` included — and none of the machinery a [session](https://vetta.sh/docs/sdk/sessions.md) brings: no agent, no tools run for you, no event log, no state between calls. Both model calls bill the organization directly, and the ledger entry carries no session or agent id.

If you want a durable agent that keeps working across turns, use [`sessions.create`](https://vetta.sh/docs/sdk/sessions#create) instead.

## messages

```ts theme={"system"}
client.proxy.messages(body: ProxyMessageCreate, window?: Window): Promise<ProxyMessage>
```

`POST /v1/proxy/anthropic/v1/messages`.

**model** `string` *required*

A Naive Managed Agents model id, exactly as [`models.list`](https://vetta.sh/docs/sdk/models) returns it.

**model\_selection** `ModelSelectionPolicy`

Optional. `{ options: { "<model id>": "<what it is for>", … }, min_confidence? }` — let the router pick which of these ids answers this call, `model` being the default. The reply's `model` names the pick; the selector's input tokens are one more `input` line on the same ledger entry. See [model auto-selection](https://vetta.sh/docs/concepts/model-selection.md#select-during-a-call).

**messages** `object[]` *required*

The conversation. Each turn is `{ role: "user" | "assistant", content }`, and `content` is a string or an array of `text` / `tool_use` / `tool_result` blocks.

**max\_tokens** `integer` *required*

The output allowance. It sets the size of the pre-flight quote held against your balance.

**system** `string`

The system prompt.

**tools** `object[]`

Tools the model may call, each `{ name, description?, input_schema }`. You run them and send the results back as `tool_result` blocks.

**thinking** `object`

Optional, `{ type: "disabled" }` only: run at the model's lowest published effort. A reasoning model spends its reasoning out of `max_tokens`, so a small `max_tokens` can come back with empty `content`.

`window` is the second argument, not a body field: the Messages format has no room for a [completion window](https://vetta.sh/docs/concepts/completion-window.md), so it travels as the `Vetta-Window` header. Unset means `immediate`, and a window is never quietly downgraded — a model with no published price in the window you asked for is refused with `window_unavailable` before anything is spent.

```ts theme={"system"}
const reply = await client.proxy.messages(
  {
    model: "openai/gpt-oss-120b",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Name three sorting algorithms." }],
  },
  "immediate",
);
```

The reply carries `id` (the request id, the same value as the `x-request-id` header and the ledger entry), `model` (the id you sent), `resolved_model` (the model that actually answered — what `vetta/auto` ran on — or `null`), `content`, `stop_reason`, and `usage` with the format's four token counters. The exact five-tier split you were charged on is on [`credits.ledger`](https://vetta.sh/docs/sdk/credits).

There is deliberately **no streaming method**. Set up a Messages-format client against `<baseUrl>/v1/proxy/anthropic` and stream with that — keeping it working unchanged is what the endpoint is for. Fields the endpoint cannot carry (`temperature`, `top_p`, `stop_sequences`, `thinking`, …) are absent from `ProxyMessageCreate` for the same reason the server refuses them: a silently dropped setting is a call you paid for and did not ask for.

## Configuring an agent's tools

Not a route, and not on `client.proxy` — but it belongs next to it, because both are things you write rather than read. An agent's [toolset](https://vetta.sh/docs/capabilities/tools.md) is a field on the agent, and `configs` is replaced wholesale on the wire, so changing one tool by hand means resending every other one unchanged. `withTool` does that for you:

```ts theme={"system"}
import { createClient, withTool } from "@usenaive-sdk/managed-agents";

const agent = await client.agents.get("agt_01H...");

await client.agents.update(agent.id, {
  tools: withTool(agent.tools, "web_fetch", {
    permission: "ask",
    config: { allowed_domains: ["docs.example.com"], max_content_tokens: 2000 },
  }),
});
```

Every field of the settings is optional and what you omit keeps its current value; `config` merges key by key, so setting a cap does not clear a domain filter. A tool named for the first time is created enabled at the toolset's own default permission. `WebToolConfig` types the domain filters and content cap that `web_search` and `web_fetch` read; `MediaToolConfig` types the `models` default that `generate_image` and `generate_video` read — the first id is what runs when the agent names none, and it is a default, not an allow-list (see [generation tools](https://vetta.sh/docs/capabilities/tools.md#generation-tools)).

## completions

```ts theme={"system"}
client.proxy.completions(body: ProxyCompletionCreate, window?: Window): Promise<ProxyCompletion>
```

`POST /v1/proxy/openai/v1/chat/completions`. The same proxy in the Chat Completions dialect, for a client that speaks that envelope and nothing else.

Same balance, same rate card, same meter as [`messages`](#messages) — only the envelope differs; `model_selection` works the same way here. `max_completion_tokens` (or `max_tokens`) is optional here, unlike the Messages door: omit it and the call is bounded by whatever the model may emit.

Like its sibling, there is no streaming method: a client that streams this dialect already has one, and the endpoint exists so that client keeps working. Point it at `<baseUrl>/v1/proxy/openai/v1`.

```ts theme={"system"}
const reply = await client.proxy.completions({
  model: "z-ai/glm-5.3-flash",
  reasoning_effort: "low", // one of the model's published `efforts`; any other is refused
  messages: [{ role: "user", content: "Summarise this invoice." }],
});

console.log(reply.choices[0]?.message.content, reply.usage.total_tokens);
```

## calls

```ts theme={"system"}
client.proxy.calls(query?: ListQuery): Promise<Page<ProxyCallTrace>>
```

`GET /v1/proxy/calls`. Every proxied call leaves a **trace** beside its ledger entry: the key that sent it, the model that actually answered, what the vendor charged us, and the literal prompt and reply. Newest first, keyset-paged like every other list; every row carries its bodies inline.

Needs a key with `audit:read`, **not** the `proxy:write` that makes the calls. The scope you hand to a sandbox or a third-party client cannot read back what your organization has been sending; see [Call traces](https://vetta.sh/docs/api/proxy.md#call-traces) for what is stored and who can read it.

```ts theme={"system"}
const { data } = await client.proxy.calls({ limit: 20 });

for (const call of data) {
  console.log(call.created_at, call.model, "->", call.resolved_model, call.provider);
  console.log("  tokens:", call.usage.input, "in /", call.usage.output, "out");
  console.log("  bodies:", call.content_scope, call.request_bytes, "bytes in");
}
```

## call

```ts theme={"system"}
client.proxy.call(requestId: string): Promise<ProxyCallTrace>
```

`GET /v1/proxy/calls/{request_id}`. One trace, addressed by the request id you already have: it is the `id` on the reply, the value on `x-request-id`, and the idempotency key of the call's ledger entry — one call, one identifier, three places.

This read returns the literal `request` and `response`. Only a row written before the current capture can say `metadata` or `object`, with null bodies; `expires_at` is null on every new row.

```ts theme={"system"}
const call = await client.proxy.call("req_01j9y2p0q4r5s6t7u8v9w0x1y2");

console.log(call.request?.messages, call.response?.text, call.response?.reasoning);
```


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.