# Review rubric: tandem-long-horizon

The reviewer scores the final workspace of every trial whose `hidden-tests` gate passed. It sees
the task (`workloads/project-tracker/instruction.md`), the starting repo and the diff; it never
sees the hidden tests. Every score quotes the lines it is based on (`path:line`). A sample of
trials is scored twice and must agree within 1 point.

## code-quality (requirement `quality`, scale 1–4)

Judge four things, then pick the level that fits best overall.

| Criterion | Look for |
| --- | --- |
| Follows the repo's patterns | Builds on the skeleton's `createApp`, `AppOptions` and file layout instead of a parallel server. No new dependencies. One router, one error helper, one persistence layer. |
| Handles errors | Every error path in the contract answers with the documented status and error code, in the documented check order; bad input never crashes the server or leaks a stack trace. |
| Tests check real behavior | The contender's own tests under `test/` call the app over HTTP, including error cases, and would fail if a feature broke. Tests that only assert mocks, or snapshot whatever the code returns, don't count. |
| No dead code | No commented-out blocks, unused exports, debug logging, duplicated area code or half-finished alternatives left from parallel work. |

| Score | Level |
| --- | --- |
| 4 | All four criteria met. A maintainer would merge it as is. |
| 3 | Minor issues in one or two criteria (a missed helper, one untested error path, a stray unused function). Merge after small fixes. |
| 2 | A real gap in one criterion (tests that don't exercise behavior, inconsistent error bodies, two copies of the same helper written by different sessions). Needs another pass. |
| 1 | Gaps in several criteria, or code that works by accident (hard-coded answers, special cases for test inputs). |

Cross-cutting checks for this workload:

- Role checks and the archived-project rule are enforced in one place, not copied per route.
- Every write goes through the audit log in the same way; persistence is on disk before the
  response, through one code path.
- The 1.x migration is one function with its own tests, not branches scattered through the loaders.
