# Review rubric: tandem-vs-claude-code

The reviewer scores the final workspace of every trial whose `hidden-tests` gate passed. It sees
the task (`instruction.md`), the starting repo and the diff; it never sees the hidden tests. Every
score quotes the lines it is based on (`path:line`). A sample of trials is scored twice and must
agree within 1 point.

## code-quality (requirement `quality`, scale 1–4)

Judge four things, then pick the level that fits best overall.

| Criterion | Look for |
| --- | --- |
| Follows the repo's patterns | Uses the existing helpers (`HttpError`, `sendJson`, the router, `readJson`), file layout and naming instead of inventing parallel ones. No new dependencies. |
| Handles errors | Every error path in the task's contract answers with the documented status and `{ error: { code, message } }`; bad input never crashes the server or leaks a stack trace. |
| Tests check real behavior | The contender's own tests exercise the public interface (HTTP routes or exported functions), including error cases, and would fail if the feature broke. Tests that only assert mocks, or snapshot whatever the code returns, don't count. |
| No dead code | No leftover session code after the JWT move, no commented-out blocks, unused exports, debug logging or half-finished alternatives. |

| Score | Level |
| --- | --- |
| 4 | All four criteria met. A maintainer would merge it as is. |
| 3 | Minor issues in one or two criteria (a missed helper, one untested error path, a stray unused function). Merge after small fixes. |
| 2 | A real gap in one criterion (tests that don't exercise behavior, inconsistent error bodies, a parallel copy of an existing helper, dead session code left in place). Needs another pass. |
| 1 | Gaps in several criteria, or code that works by accident (hard-coded answers, special cases for test inputs). |

Per workload, the reviewer also checks:

- **todo-api**: ownership checks happen in one place, not copied per route; listing doesn't scan
  every user's todos.
- **auth-refactor**: signature comparison is constant-time (`timingSafeEqual`); `alg` is checked
  before trusting the payload; no `sid`/cookie code remains.
- **bug-hunt**: the fix is in the CSV codec (`src/csv.ts`), not patched around in `orders.ts`;
  regression tests cover the reported cases.
