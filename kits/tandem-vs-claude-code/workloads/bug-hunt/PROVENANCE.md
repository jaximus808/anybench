# bug-hunt provenance (kit-side, never copied into the workspace)

This workload is a real fix that was reverted, replayed as a task.

1. `report-export` 1.3.x shipped commit **"fix(csv): quote and unquote fields per RFC 4180 (#212)"**.
   It replaced the naive `join(",")` / `split(",")` codec in `src/csv.ts` with an RFC 4180 one and
   added two test files, `test/csv-quoting.test.ts` (10 tests) and `test/orders-roundtrip.test.ts`
   (2 tests).
2. During the 1.4.0 release a "simplify CSV" cleanup was done with `git revert` of that commit,
   which took the tests out with it, so CI stayed green and the bug came back (ticket #231).

How the kit uses it:

| Kit part | Comes from |
| --- | --- |
| `workloads/bug-hunt/input/` (the starting repo) | the tree right after the revert |
| `gates/hidden-tests/bug-hunt/*.test.ts` (the grader) | the test files the fix commit added, unchanged |
| `proof/oracle/bug-hunt/` (the reference solution) | the source half of the fix commit (`src/csv.ts`) |
| `instruction.md` | the support ticket, with no hint of the fix or its tests |

The agent never sees the fix commit: the workspace is a fresh one-commit repo of the reverted tree.

`scripts/verify-proof.sh` re-checks this story on every run (the "revert check"): it commits the
starting repo, commits oracle + hidden tests as the fix, runs `git revert --no-edit HEAD`, and
asserts the reverted tree is byte-identical to the starting repo and that the fix added exactly the
hidden test files.
