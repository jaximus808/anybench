> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# agents

> Create, version, and retire agents — client.agents, one method per route.

The agent is the durable, versioned configuration a [session](https://vetta.sh/docs/sdk/sessions.md) runs. Ten methods, one per route; objects parse with the core `AgentSchema`. API detail: [Agents](https://vetta.sh/docs/api/agents.md).

## create

```ts theme={"system"}
client.agents.create(body: AgentCreate): Promise<Agent>
```

`POST /v1/agents`. `AgentCreate` requires `name` (1–100 characters), `model` (an id `client.models.list()` publishes, or `vetta/auto`) and `budget` (`max_task_micro_usd` at most `cap_micro_usd`); everything else on the agent config (`system`, `window`, `harness`, …) is optional. `harness` selects the agent loop and defaults to `pi`; [`client.harnesses.list()`](https://vetta.sh/docs/sdk/harnesses) publishes the set you can choose from.

```ts theme={"system"}
const budget = { cap_micro_usd: 50_000_000, max_task_micro_usd: 5_000_000, period: "month" } as const; // $50 / $5
const agent = await client.agents.create({ name: "support", model: "...", budget });
// `handoffs` (type `Handoffs`, exported): who it may send work to with `send_to_agent` —
// `true` (any agent of the organization, the default), `false`, "team" (its roster), or agent names.
const closed = await client.agents.create({ name: "auditor", model: "...", budget, handoffs: false });
// `model_selection` (type `ModelSelectionPolicy`): pick one of these ids per turn; `model` is the default.
const picker = await client.agents.create({
  name: "triage",
  model: "a/one",
  budget,
  model_selection: { options: { "a/one": "routine chat", "b/two": "hard reasoning" }, min_confidence: 0.5 },
});
```

## list

```ts theme={"system"}
client.agents.list(query?: ListQuery): Promise<Page<Agent>>
```

`GET /v1/agents`, cursor-paginated. See [Pagination](https://vetta.sh/docs/sdk/pagination.md).

## get

```ts theme={"system"}
client.agents.get(id: string): Promise<Agent>
```

`GET /v1/agents/{id}`.

## update

```ts theme={"system"}
client.agents.update(id: string, body: AgentPatch): Promise<Agent>
```

`PATCH /v1/agents/{id}`. Every config field is optional; a successful patch **mints a new version** rather than editing the current one. Pass `expected_version` for optimistic concurrency — a mismatch is a `409 conflict`.

## listVersions

```ts theme={"system"}
client.agents.listVersions(id: string): Promise<Page<AgentVersion>>
```

`GET /v1/agents/{id}/versions`. History is immutable and never rewritten.

## getVersion

```ts theme={"system"}
client.agents.getVersion(id: string, version: number): Promise<AgentVersion>
```

`GET /v1/agents/{id}/versions/{version}`.

## rollback

```ts theme={"system"}
client.agents.rollback(id: string, body: { to_version: number; expected_version?: number }): Promise<Agent>
```

`POST /v1/agents/{id}/rollback`. Mints a **new** version cloning `to_version` — a rollback is itself a versioned change, so history stays linear and auditable.

## spend

```ts theme={"system"}
client.agents.spend(id: string, query?: { by?: "component" }): Promise<AgentSpend>
```

`GET /v1/agents/{id}/spend` — metered spend for the agent's current budget period, integer micro-USD:

```json theme={"system"}
{ "agent_id": "agt_01H...", "period": "month", "period_start": "2026-08-01T00:00:00Z", "spent_micro_usd": 1250000 }
```

`by: "component"` adds a `by_component` breakdown — `model` (the five token tiers summed), `computer`, `search`, `media`, and `other` for anything a debit did not itemise. A component with no spend is absent, and the breakdown always sums to `spent_micro_usd`. Absent unless asked for.

Computer time is billed to the agent and to no session, so `spent_micro_usd` is more than the agent's sessions' `consumed_micro_usd` added up; `computer` is the difference.

## computer

```ts theme={"system"}
client.agents.computer(id: string): Promise<Computer | null>
```

`GET /v1/agents/{id}/computer`. The agent's one [computer](https://vetta.sh/docs/sdk/computers.md), which every session of the agent works on, or `null` before any session has needed one. The machine under it can change while its files are kept, so read this rather than caching a `cmp_` id. See [An agent's computer](https://vetta.sh/docs/api/computers.md#an-agents-computer).

## delete

```ts theme={"system"}
client.agents.delete(id: string): Promise<Deleted & { removed_from: { id: string; name: string; version: number }[] }>
```

`DELETE /v1/agents/{id}`. Answers the standard `{ id, object, deleted: true }` acknowledgement, plus `removed_from`: every coordinator whose team roster named this agent and now has a new version without it. Empty when the agent was on no roster.

> [!WARNING]
>
> Deleting an agent also deletes every [deployment](https://vetta.sh/docs/sdk/deployments.md) that runs it, so its schedules stop firing. Nothing asks first; list them with `client.deployments.list()` before you delete.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.