> ## Documentation Index
> Fetch the complete documentation index at: https://vetta.sh/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# outcomes

> A description and a Markdown rubric a grader holds a session to — client.outcomes.

An outcome says what "done" means for a task: a plain-language `description` and a Markdown rubric. Three methods; objects parse with the core `OutcomeSchema`. An outcome is **immutable** — there is no update and no delete; a changed rubric is a new outcome. Outcomes and their evaluations are kept for the life of the organization. Attach one to a session with [`sessions.setOutcome`](https://vetta.sh/docs/sdk/sessions#setoutcome).

## create

```ts theme={"system"}
client.outcomes.create(body: OutcomeCreate): Promise<Outcome>
```

`POST /v1/outcomes`. `name` (1–200) and `description` (1–4000) are required. Give exactly one of `rubric` (inline Markdown) and `rubric_file` (a `fil_` id of a file in your organization, read when the outcome is attached to a session); both or neither is `validation_failed`. `max_iterations` is 1–20, default `3`.

```ts theme={"system"}
const outcome = await client.outcomes.create({
  name: "refund-quality",
  description: "A correct, policy-compliant refund.",
  rubric: "# Refund rubric\n- Correct order identified\n- Amount matches policy\n",
  max_iterations: 4,
});
```

## list

```ts theme={"system"}
client.outcomes.list(query?: ListQuery): Promise<Page<Outcome>>
```

`GET /v1/outcomes`, newest first, cursor-paginated.

## get

```ts theme={"system"}
client.outcomes.get(id: string): Promise<Outcome>
```

`GET /v1/outcomes/{id}`. An unknown id is `not_found` (404).

## Reading the result

[`sessions.get`](https://vetta.sh/docs/sdk/sessions#get) returns `outcome_evaluations[]`, one `OutcomeEvaluation` per outcome attached to the session, oldest first; the last is the active one.

```ts theme={"system"}
const { outcome_evaluations } = await client.sessions.get(sessionId);
for (const e of outcome_evaluations ?? []) console.log(e.outcome_id, e.result, e.iteration, e.explanation);
```

`result` is `pending` until the first grade lands, then `satisfied`, `needs_revision`, `failed`, `max_iterations_reached` or `interrupted`.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.