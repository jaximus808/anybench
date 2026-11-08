# packages/agents

One folder per Naïve agent role, next to `src/`:

```
packages/agents/<role>/prompt.md           system prompt (required)
packages/agents/<role>/config.json         {role, model, harness, window, description,
                                            budget{cap_micro_usd, max_task_micro_usd, period}, tools{configs, ...}}
packages/agents/<role>/output.schema.json  JSON schema of the session's final document (optional)
```

- `loadRole(role)`, `listRoles()`, `roleAgentSpec(role, overrides?)` → the `ensureAgent` spec of
  `@anybench/naive`. The spec fingerprint covers the prompt, so a prompt change mints a new agent
  version and an unchanged role is a no-op.
- `syncAgents(client, {roles?})` ensures every role on Naïve (429 "at capacity" retried).
- Deploy: `pnpm --filter @anybench/agents sync [--dry-run] [--role <r>]... [--model <m>]`
  (reads `NAIVE_API_KEY` from the environment; `--dry-run` makes no call).
- Orchestrator stages run a role through `runAgentStage` in `apps/server/src/jobs/agent-session.ts`.

See plan.md, section 11.
