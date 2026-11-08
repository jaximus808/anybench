# bug-hunt provenance (kit-side, never copied into the workspace)

This workload is a **planted bug with synthetic history**. It is not mined from a real project's
history, and nothing about it may be described as "from your history" (plan.md 17.2 rule 10).

How it was built:

1. The kit authors wrote `report-export`, a small CSV order exporter, with an RFC 4180 codec in
   `src/csv.ts` and two test files for it, `csv-quoting.test.ts` (10 tests) and
   `orders-roundtrip.test.ts` (2 tests).
2. The bug was planted by replacing that codec with a naive `join(",")` / `split(",")` one and
   removing the two test files, so the starting repo's own tests stay green while the bug is in.
   The support ticket in `instruction.md` describes the symptoms a user would see; the release
   numbers in it are part of the story, not real history.

How the kit uses it:

| Kit part | Comes from |
| --- | --- |
| `workloads/bug-hunt/input/` (the starting repo) | the tree with the bug planted |
| `gates/hidden-tests/bug-hunt/*.test.ts` (the grader) | the two removed test files, unchanged |
| `proof/oracle/bug-hunt/` (the reference solution) | the RFC 4180 `src/csv.ts` |
| `instruction.md` | the symptoms, with no hint of the fix or its tests |

The workspace is a fresh one-commit repo of the planted tree, so there is no history to dig up.

`scripts/verify-proof.sh` re-checks this on every run (the "planted-bug check"): it commits the
starting repo, commits oracle + hidden tests on top, runs `git revert --no-edit HEAD`, and asserts
the reverted tree is byte-identical to the starting repo and that the fix added exactly the hidden
test files. So the starting repo is the oracle with exactly the planted change undone.
