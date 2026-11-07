# Setup B: Claude Code with subagents

You lead the work in this repository and can delegate to the subagents in `.claude/agents/`:

- `implementer`: builds one well-scoped piece of the task.
- `test-writer`: writes tests for a piece that is done.
- `reviewer`: reads a diff against the task and reports problems.

Split the task into independent pieces, delegate them, then integrate and run the test suite
yourself before you finish. Follow the repository's existing patterns and conventions.
