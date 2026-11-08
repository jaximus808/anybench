# Task mining from a repo's history (TDM-186)

Code: `packages/kit/src/mine/` (exported from `@anybench/kit`). Tests:
`packages/kit/test/tdm186-mine.test.ts` (selection, runners, parsers, tar, held-out, groups) and
`packages/kit/test/tdm186-mine-docker.test.ts` (the done condition on docker-local).
Host: macOS arm64, Docker 29.4.3, git 2.50.1, node v26.0.0. Images: `node:22` (fixture),
`python:3.12-slim` (Python 3.12.14, pytest 9.2.0 at run time). No Naïve spend.

## Pipeline

1. **Select** (`selectMineCandidates`, git objects only, nothing checked out):
   `git log --no-renames --raw --numstat`. A candidate is a non-merge commit that adds or
   modifies test files (`isTestPath` from ingest) AND changes non-test source. Docs, changelogs,
   CI and repo-housekeeping config (`.pre-commit-config.yaml`, `.gitignore`, ...) are kept out of
   the fix (`ignored_files`). Drops: `merge`, `root_commit`, `shallow_boundary`, `docs_only`,
   `lockfile_only`, `no_test_change`, `tests_only`, `vendored_only`, `no_source_change`,
   `deletes_or_renames` (the oracle is a file overlay, it cannot delete), `binary_change`,
   `too_large` (defaults: ≤8 test files, ≤6 fix files, ≤300 fix lines, ≤600 test lines).
2. **Verify** (`verifyMineCandidate`, through `ComputeProvider`): the parent tree goes to the
   computer as a tar built from git blobs (no `.git` at all; the unpack step fails the candidate
   with `history_leak` if a `.git` shows up). Install once, apply the commit's test files, run the
   targeted tests 3×; apply the fix, run 3× again. FAIL_TO_PASS = fail/missing in every before-run
   and pass in every after-run; PASS_TO_PASS = pass in all 6. A test that flips within one state and
   is one of the commit's tests drops the candidate (`flaky`); a flipping bystander is only kept out
   of PASS_TO_PASS (`flaky_excluded`).
3. **Materialize** (`materializeMinedTask`): `workloads/<id>/{input/,instruction.md,setup.sh}`,
   `gates/hidden-tests/<id>/{tests.json,files/**}`, `proof/oracle/<id>/**`, `mined/<id>.json`,
   `mined/report.json`. `checkMinedTaskLeaks` re-reads the workload and throws `MineLeakError` if it
   holds a post-change test or fix file (byte match), a `.git`, the commit id, a FAIL_TO_PASS test
   name, an added test path or a line the fix adds.

## The fixture (docker-local, `node:22`)

```
$ cd packages/kit && ANYBENCH_MINE_LOG=1 npx vitest run test/tdm186-mine-docker.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  18.88s
```

13 commits: 7 candidates, 5 verified 3/3 (2 held out). Dropped: `flaky` ("1 test(s) flip between
runs; test/retry.test.js > attempt succeeds passed 0/3 before and 1/3 after the fix"),
`passes_before_fix` (refactor + an already-green test), `docs_only` ×2, `tests_only`,
`lockfile_only`, `merge`, `root_commit`. The workload's `setup.sh` gives a repo where
`git rev-list --count --all` is 1, the parent commit object is absent, and the only subject is
"starting repo". Replaying the materialized gate files then the oracle on the host flips the
FAIL_TO_PASS tests from failing to passing.

## Real repo: hukkin/tomli on docker-local (`python:3.12-slim`)

```
$ git clone https://github.com/hukkin/tomli.git      # head 43a86ade8b795c6ef9b4ec53372a607cd1ed426f
$ node mine-real.ts repos/tomli python:3.12-slim https://github.com/hukkin/tomli kit-tomli out.json
elapsed_s=644
 "commits_scanned": 347, "candidates": 39, "verified": 29, "held_out": 10,
 "drop_counts": { "no_test_change": 193, "docs_only": 46, "tests_only": 25, "merge": 22,
   "deletes_or_renames": 10, "passes_before_fix": 10, "no_source_change": 6, "too_large": 5,
   "root_commit": 1 }
TASK mined-456267127d 1e6e869a 2026-10-06 - f2p=1 p2p=7 tests/test_misc.py::TestMiscellaneous::test_inline_array_recursion_limit | AssertionError: RecursionError not raised
TASK mined-4617567fd1 9eb2125e 2026-01-10 - f2p=1 p2p=15 tests/test_data.py::TestData::test_valid | [localtime] tomli._parser.TOMLDecodeError: Expected newline or end of document after a statement (at line 2, column 5)
TASK mined-41d46f1af2 4e245a4b 2024-10-02 - f2p=1 p2p=5 tests/test_error.py::TestError::test_type_error | AssertionError: "a bytes-like object is required, not 'str'" != "Expected str object, not 'bytes'"
TASK mined-c7acf8b32b 8d34a601 2021-06-28 held-out f2p=1 p2p=461 tests/test_extras.py::test_invalid[invalid-day] | ValueError: day is out of range for month
... (29 tasks; 103 FAIL_TO_PASS, 3610 PASS_TO_PASS, 0 flaky bystanders, 4 pass→fail)
```

- 29 tasks verified fail-before / pass-after 3 of 3; 10 held out; 5 dated after a 2025-01-01
  cutoff (`cutoff.after_cutoff`), the rest earlier.
- The 10 `passes_before_fix` drops are real: refactors and perf commits whose test edits were
  already green (e.g. b7e1bccc's test is skipped below Python 3.15).
- `groupMinedTasks` (5–10 tasks, same area, ≤90 days): 2 backlogs (`tomli` ×10 and a mixed
  group of 8 from the 2021 renames `lil_toml` → `ltoml` → `tomli`); 11 ungrouped.
- Every materialized workload passed the leak check; a `grep` of each commit's 7-char id over
  `workloads/` found nothing. A replay in a fresh `python:3.12-slim` container of
  mined-456267127d (setup.sh → hidden tests → oracle) printed 1 FAILED + 7 PASSED before the
  oracle and "8 passed, 1 skipped" after.

## Gotchas found on the way (each fixed, with a test where it is a parser rule)

- **mtime 0 breaks Python builds.** The first tar writer used mtime 0; flit's editable wheel
  build then failed with `ValueError: ZIP does not support timestamps before 1980` and every test
  module hit `ModuleNotFoundError: No module named 'tomli'`. Headers now carry 2000-01-01 and
  extraction uses `tar -m` (fresh mtimes, so mtime-based build caches such as cargo's see the
  fix as changed). Also `PYTHONPATH=src` for src layouts in case an old backend cannot build.
- **pytest 9 reports unittest subTest failures as `SUBFAILED[label] <id> - msg` while the parent
  says `PASSED`.** Without handling it, 3 TOML 1.1 commits (9eb2125e, 12314bde, 0921abf5) were wrongly
  `passes_before_fix`. A failed subtest now fails its parent.
- **Test requirements under `tests/requirements.txt`** (tomli 2021: `pytest-randomly`,
  `python-dateutil`): missing them made 10 candidates `no_tests_ran`. The install now reads
  `tests/requirements.txt`, `test/requirements.txt` and `requirements/tests.txt` too.
- **Changed test DATA is read by tests the commit did not touch** (948211d8 adds
  `tests/data/extras/invalid/*.toml`, read by `test_extras.py`, while only `test_misc.py`
  changed). Any changed non-code test file now runs the whole suite (`targets: []`).
- **Work dirs must not carry the commit id**: failure text quoted
  `/home/naive/anybench-mine/<sha12>/ws/...`. The dir is now named by the opaque task id and the
  workspace prefix is stripped from logs, results, symptoms and excerpts.
- **Another process removed our container mid-run** (exit 137, then `computer ... not found`);
  `docker events` showed other workers' `ab-dl-*` containers being killed at the same time. When
  the miner owns its computer and finds it lost after a failed verify, it creates a new one and
  retries that candidate once (2 losses in one run were recovered; 0 in the final run).

## Limits / follow-ups

- Issue text, underspecification screening and `anybench.yaml` wiring are TDM-60's: the task
  record carries `symptoms` and `before_output_excerpt` (raw assertion text, which can quote test
  expressions; screen before use). `instruction.md` is a placeholder.
- No gate `check.sh` is rendered for mined tasks yet: `gates/hidden-tests/<id>/tests.json` holds
  the runner, the command and the FAIL_TO_PASS / PASS_TO_PASS lists; the gate needs a check that
  copies `files/` onto the workspace, runs `test_command` as the contender uid and parses results
  with `parseTestRun`.
- PASS_TO_PASS covers the targeted test files (the whole suite when test data changed), as in
  SWE-bench, not the full suite.
- Runners: node --test (JS only), vitest, jest, mocha, pytest, go test, cargo test. ava, tape,
  uvu, jasmine and others are refused with a reason. Only the node and pytest paths ran live.
- The image must carry the toolchain (the caller picks it: `node:22`, `python:3.12-slim`, ...);
  installs need network on the computer. `setup.sh` repeats the install for the contender.
