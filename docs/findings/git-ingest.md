# Git ingest (TDM-34, `packages/kit/src/ingest/github.ts`)

git 2.50.1 (Apple Git-155), macOS, 2026-11-07.

## Partial + shallow fetch without a checkout

We never `git clone`. `init` + `remote add` + one `fetch` gives a promisor repo we read straight from objects:

```sh
git init -q dst && cd dst && git remote add origin file://$PWD/../src
git -c remote.origin.promisor=true -c remote.origin.partialclonefilter=blob:limit=100 \
  fetch -q --no-tags --depth=200 --filter=blob:limit=100 origin HEAD   # exit 0
git ls-tree -r FETCH_HEAD | awk '{print $3}' \
  | GIT_NO_LAZY_FETCH=1 git cat-file --batch-check='%(objectname) %(objectsize)'
# ac790413e2d7a26c3767e78c57bb28716686eebc 6
# 1fe2898b10adc6937ad1482a3a42d393892c5a93 missing
```

- `GIT_NO_LAZY_FETCH=1` makes filtered-out blobs print `missing` instead of downloading them. Ingest records them in `context.large_files` with a size lower bound of 1 MiB + 1.
- `git log --no-renames --name-only` needs trees only, so it works on a blob-filtered clone. Without `--no-renames` rename detection could pull blobs.
- A `--depth` boundary commit diffs against nothing and "touches" every file. Its sha is in `.git/shallow`; ingest skips it in `recent_test_commits`.
- Over `file://` the source repo needs `uploadpack.allowFilter=true` (tests set it). GitHub allows filters.
- Tags come from `git ls-remote --tags --refs origin` (names only, no objects). The default branch name comes from `git ls-remote --symref origin HEAD`.
- `GITHUB_TOKEN` goes in through `GIT_CONFIG_COUNT/KEY_0/VALUE_0` (`http.https://github.com/.extraheader`), never argv.
- Local repos are read with `GIT_OPTIONAL_LOCKS=0`, so nothing (not even the index) is rewritten.

## Fixture runs

```sh
pnpm --filter @anybench/kit exec tsx scripts/gen-digest-fixtures.ts
# agentcanvas: 92196 bytes, 628 files, 4445 ms
# hyperfine: 39199 bytes, 75 files, 3507 ms
```
