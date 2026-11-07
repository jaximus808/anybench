> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# deployments

> An agent on a cron — client.deployments.

A deployment fires an agent on a schedule without a human at the terminal. Nine methods. API detail: [Deployments](https://vetta.sh/docs/api/deployments.md).

## create

```ts theme={"system"}
client.deployments.create(body: DeploymentCreate): Promise<Deployment>
```

`POST /v1/deployments`. Requires `agent_id`, `cron`, `input_template`, and `budget_micro_usd` (the per-run budget in micro-USD; `0` runs each fire on the agent's own `budget.max_task_micro_usd`); the rest of the deployment config is optional. `agent_version` pins the exact version this cron fires; `timezone` reads the cron expression. A cron that fires more often than every 5 minutes is refused. A refused body names every invalid field in the error message, not only the first.

```ts theme={"system"}
const deploy = await client.deployments.create({
  agent_id: agent.id,
  cron: "0 9 * * 1",
  input_template: "Summarize last week's tickets",
  budget_micro_usd: 3_000_000, // $3 per run
});
```

## list

```ts theme={"system"}
client.deployments.list(query?: ListQuery): Promise<Page<Deployment>>
```

`GET /v1/deployments`, cursor-paginated.

## get

```ts theme={"system"}
client.deployments.get(id: string): Promise<Deployment>
```

`GET /v1/deployments/{id}`.

## update

```ts theme={"system"}
client.deployments.update(id: string, body: DeploymentPatch): Promise<Deployment>
```

`PATCH /v1/deployments/{id}`. `DeploymentPatch` is every config field optional **except `agent_id`**, which cannot be changed — repoint by creating a new deployment.

## run

```ts theme={"system"}
client.deployments.run(id: string): Promise<DeploymentRun>
```

`POST /v1/deployments/{id}/run`. Fire once, now — the "run it and see" verb. Does not touch the schedule.

## runs

```ts theme={"system"}
client.deployments.runs(id: string, query?: ListQuery): Promise<Page<DeploymentRun>>
```

`GET /v1/deployments/{id}/runs` — the history, each run pointing at the session it started.

## pause / resume

```ts theme={"system"}
client.deployments.pause(id: string): Promise<Deployment>
client.deployments.resume(id: string): Promise<Deployment>
```

`POST /v1/deployments/{id}/pause` and `POST /v1/deployments/{id}/resume`. Pausing stops the schedule; `run` still works while paused.

## delete

```ts theme={"system"}
client.deployments.delete(id: string): Promise<Deleted>
```

`DELETE /v1/deployments/{id}`. Past runs and their sessions remain readable.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.