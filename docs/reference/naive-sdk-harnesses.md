> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# harnesses

> The agent loops you can pick from — client.harnesses.

Two methods. A **harness** is the agent loop itself: how context is managed, how tools are chosen, how a long task is decomposed and resumed. It is one field on an agent, and nothing else about your call changes when you change it.

Unlike [`models`](https://vetta.sh/docs/sdk/models), this catalogue is a constant of the deploy rather than a live read — a harness needs an adapter compiled in, so the list cannot change without a release. It is still cursor-paged like every other listing, so you write one loop for both.

## list

```ts theme={"system"}
client.harnesses.list(query?: {
  limit?: number;
  after?: string;
}): Promise<Page<Harness>>
```

`GET /v1/harnesses`. Every harness, including those still in preview.

Each entry:

**base** `string`

The value you pass as `harness` on [`agents.create`](https://vetta.sh/docs/sdk/agents#create).

**label** `string`

A display name, for a picker.

**location** `"hosted" | "local"`

`hosted` runs on our infrastructure. `local` runs on your own machine against your own logged-in account.

**billing** `"usage" | "account"`

`usage` is metered to your credit balance. `account` bills to the account you are already logged in to, so it does not touch your balance.

**status** `"ga" | "preview"`

`preview` means the loop runs but its contract may still move.

**execution** `"isolate" | "sandbox" | "local"`

Where the loop runs, and therefore **what an idle session costs**. `isolate` runs in the session itself and holds no sandbox between turns. `sandbox` runs the agent on a micro-VM, which the session holds across turns. `local` runs on your own machine. This is a different question from `location`, which is about who operates it.

**runnable** `boolean`

Whether a session on it runs **today**. This is a different question from `status`: a harness can be `preview` and runnable, or published and not yet runnable. Starting a session on one with `runnable: false` is a `501` naming the field — refused at start, never discovered part-way through a turn.

**capabilities** `object`

What the loop can be admitted for — see below.

### Capabilities

Harnesses differ, and the differences are load-bearing. Read them before you create an agent:

**approvals** `boolean`

The loop can hold a tool call and wait for a decision. A harness with `false` here cannot serve a toolset whose permission is `ask`.

**structured\_output** `boolean`

The loop can honour `structured_output_required`.

**streaming\_deltas** `boolean`

The loop emits incremental `message.delta` events. With `false`, you still get `message.completed` — the answer arrives whole rather than as it is written.

**injected\_tools** `boolean`

The tools Naive Managed Agents contributes reach the loop's model — the [team tools](https://vetta.sh/docs/team/delegation.md), `mcp_servers` and [connected accounts](https://vetta.sh/docs/sdk/identities.md) — governed by the agent's `tools` policy. It does not say by which road: a loop Managed Agents hosts is handed them for the turn, an agent that is a CLI process in a machine of its own is given a session-scoped tool endpoint to call. On the second road a tool whose permission is `ask` is left out rather than gated, and `wait_for_agents` does not pause the turn. `agents.create` refuses a `multiagent` or a non-empty `mcp_servers` on a harness declaring `false`, naming the field; no published harness declares `false`.

A session that asks for a capability its harness does not declare is refused at start with a `400` naming the field. It is never a quiet best effort that looks like it worked.

> [!WARNING]
>
> One entry is currently optimistic: `vetta` publishes `structured_output: true` and its loop has no
> way to submit one, so the pairing is admitted by every gate and can then only fail at the turn. Run
> `structured_output_required` on `pi`. The per-harness values for all four capabilities are in
> [Harness capabilities](https://vetta.sh/docs/concepts/harness-capabilities.md).

```ts theme={"system"}
const harnesses = await client.harnesses.list();

for (const h of harnesses.data) {
  console.log(h.base, h.status, h.capabilities.approvals ? "can ask" : "cannot ask");
}
```

## retrieve

```ts theme={"system"}
client.harnesses.retrieve(base: string): Promise<Harness>
```

`GET /v1/harnesses/{id}`. One harness, for when you already hold a base and want to know what it can be admitted for.

A base with no adapter behind it is a `404`, not an empty row — including an id reserved in a picker but not yet runnable.

```ts theme={"system"}
const pi = await client.harnesses.retrieve("pi");
```


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.