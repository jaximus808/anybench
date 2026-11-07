> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# models

> The model catalogue a caller picks from — client.models.

Three methods: two read the catalogue, one picks from it. The catalogue is read live from the network, so it is cursor-paged like every other listing — and a model published this morning is listed this morning.

## list

```ts theme={"system"}
client.models.list(query?: {
  window?: string;
  search?: string;
  limit?: number;
  after?: string;
}): Promise<Page<Model>>
```

`GET /v1/models`. The `window` filter answers "what could I run in this window?"; `search` matches free text against the id and the name. Hundreds of models are catalogued, so page it — `limit` defaults to 20 and caps at 100.

Each entry:

**id** `string`

The model id you pass as `model` on [`agents.create`](https://vetta.sh/docs/sdk/agents#create).

**context\_window** `integer`

Native context size in tokens.

**max\_output\_tokens** `integer`

The longest reply this model may produce, and what the pre-flight quote is bounded by.

**supported\_windows** `Window[]`

The window configurations this model can serve.

**efforts** `("low" | "medium" | "high")[]`

The effort levels this model accepts.

```ts theme={"system"}
const models = await client.models.list({ search: "glm", limit: 5 });
```

## retrieve

```ts theme={"system"}
client.models.retrieve(id: string): Promise<Model>
```

`GET /v1/models/{id}`. One entry, for the id you already hold — checking what an agent's pinned model can do without paging the catalogue to find it. An id this deploy does not serve is a `not_found` error, so this is also how you validate one before you run it.

```ts theme={"system"}
const model = await client.models.retrieve("z-ai/glm-5.3-flash");
```

## autoSelect

```ts theme={"system"}
client.models.autoSelect(body: {
  options: Record<string, string>;                       // catalogue id → what it is for, 2–16 entries
  messages: { role: "user" | "assistant"; content: string }[]; // 1–32 turns, ≤ 32000 characters in all
  default?: string;                                      // one of the options keys
  min_confidence?: number;                               // > 0 and ≤ 1; requires `default`
}): Promise<ModelSelection>
```

`POST /v1/models/auto_select`. An **optional add-on** — a choice over ids you name, given the conversation so far ([Model auto-selection](https://vetta.sh/docs/concepts/model-selection.md) is the capability in full). The answer is one of your `options` keys, meant to be handed straight to the next call in the same program as `model`: [`proxy.messages`](https://vetta.sh/docs/sdk/proxy), or an agent's or session's `model`. It selects and stops; it does not call the model it picked, and it changes nothing about routing or `vetta/auto`.

```ts theme={"system"}
const messages = [{ role: "user" as const, content: "Rename every helper in src/util.ts to camelCase." }];
const pick = await client.models.autoSelect({
  options: {
    "z-ai/glm-5.3-flash": "Routine coding, edits and tool use",
    "deepseek/deepseek-v4-flash-0731": "Strict JSON output that must match a schema",
    "google/gemma-4-31B-it": "Short factual answers where speed matters",
  },
  messages,
  default: "z-ai/glm-5.3-flash",
  min_confidence: 0.5,
});
// pick.model is a concrete catalogue id the caller then passes to proxy.messages / an agent's `model`.
```

The same `{ options, min_confidence }` policy can also ride on the call itself as `model_selection` — on [`proxy.messages` / `proxy.completions`](https://vetta.sh/docs/sdk/proxy) per call, or on an [agent](https://vetta.sh/docs/sdk/agents.md) per turn — so the router runs the pick and the model in one step. `autoSelect` is for when you want the id in hand first — see [letting the call pick for itself](https://vetta.sh/docs/concepts/model-selection.md#select-during-a-call).

**model** `string`

One of the `options` keys.

**confidence** `number | null`

The selector's probability for its own choice; `null` when it reported no distribution.

**probabilities** `Record\<string, number\> | null`

The full distribution over the `options` keys, or `null`.

**defaulted** `boolean`

`true` only when `default` was returned in place of the selector's pick.

**spent\_micro\_usd** `number`

What this call debited, in integer micro-USD — what the ledger actually took.

**usage** `\{ input_tokens: number \}`

The input tokens the selection consumed, or the pre-flight estimate when none were reported.

`default` applies only under `min_confidence`: when the selector's confidence for its pick is `null` or below the threshold, `model` is `default` and `defaulted` is `true`, with `confidence` and `probabilities` still reporting what it said. `min_confidence` without `default` is a `validation_failed` on `min_confidence`.

It **fails closed**. A deploy with no selector is `feature_not_configured`; an unreachable selector is `rate_limited` or `internal_error`, as the proxy reports an upstream failure; an answer outside your options is `internal_error`. Each is the same [`ApiError`](https://vetta.sh/docs/sdk/errors) every other method throws, with the same codes, and none of them is debited — `default` is a confidence policy, not an outage policy, so catch the error if you want to fall back on one.

It is an organization-level call billed as **input tokens**: the conversation is estimated first and the balance must cover the quote (else `insufficient_credits`), then one debit with one `input` line item lands under the request id, readable through [`credits.ledger`](https://vetta.sh/docs/sdk/credits). `spent_micro_usd` on the reply is that amount. Every validation rule — exact catalogue ids only, 2–16 options, 1–32 turns and 32000 characters in all, nothing truncated for you — is spelled out on the [API page](https://vetta.sh/docs/api/models.md#choose-a-model-for-a-conversation).

> [!NOTE]
>
> `vetta/auto` is in the catalogue like any other id, and picks the model per request. It serves the
> `immediate` window only, and is quoted against a price ceiling then billed at the rate of the model
> that answered — see [Naive Managed Agents Auto](https://vetta.sh/docs/concepts/model-router.md#naive-managed-agents-auto).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.