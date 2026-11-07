# Git ingest (TDM-34, `packages/kit/src/ingest/github.ts`)

git 2.50.1 (Apple Git-155), macOS, 2026-11-07.

## Two-step partial + shallow fetch without a checkout

We never `git clone` and never check out. `init` + `remote add -- origin <url>` + two fetches, read straight from objects:

1. The tip with blobs up to 1 MiB: `fetch --no-tags --no-recurse-submodules --depth=1 --filter=blob:limit=1m origin --end-of-options <ref>`. The commit is then `rev-parse --verify -q --end-of-options FETCH_HEAD^{commit}`.
2. History for the commit log, as commits and trees only: `fetch ... --deepen=<depth-1> --filter=blob:none origin --end-of-options <sha>`. Fetching by sha means a branch that moves between the two steps can't swap the tip.

Run against a 4-commit file:// repo:

```sh
git -c remote.origin.promisor=true -c remote.origin.partialclonefilter=blob:limit=1m \
  fetch -q --no-tags --no-recurse-submodules --depth=1 --filter=blob:limit=1m origin --end-of-options HEAD
C=$(git rev-parse --verify -q --end-of-options 'FETCH_HEAD^{commit}')   # c963fb25...
git -c remote.origin.promisor=true fetch -q --no-tags --no-recurse-submodules \
  --deepen=199 --filter=blob:none origin --end-of-options $C              # exit 0
git log --oneline $C | wc -l    # 4
ls .git/shallow                 # No such file (deepening to the root clears it)
```

Gotchas:

- Without `--verify`, `git rev-parse --end-of-options X` prints the literal `--end-of-options` as part of its output. Use `--verify -q`.
- With `--end-of-options`, an option-shaped ref is read as a refspec and refused: `git fetch origin --end-of-options '--upload-pack=touch PWNED;git-upload-pack'` gives `fatal: invalid refspec '--upload-pack=...'` and no PWNED file. Refs are also validated up front (`isSafeGitRef`: no leading `-`, no whitespace, control characters, `..`, `:`, `^`, `~`, `?`, `*`, `[`, `\`, `@{` or `.lock`; any 40-hex sha is allowed). A bad URL ref gives `bad_url`, a bad local `rev` gives `bad_ref`.
- git config is passed through `GIT_CONFIG_COUNT/KEY_n/VALUE_n`: `protocol.allow=never` plus `protocol.https.allow=always` and `protocol.file.allow=always` (no ext::, ssh or git://), `fetch.recurseSubmodules=false`, and the token header.

## Bounds

- Each git command has its own timeout (180 s) and shares the deadline of the whole ingest (`deadlineMs`, 300 s by default). Past it, ingest throws `timeout`.
- Each git command's stdout is capped at 64 MiB, or `too_large`. Blob reads are cut short at their cap instead of failing.
- A tree with more than 200,000 entries throws `too_large`.
- Ordering uses code points, not `localeCompare`, so output is byte-identical across machines. Tests check this on two runs of the local path and two of the file:// path, and check that local and remote output match.

## Filtered blobs and the commit log

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
pnpm --filter @anybench/kit exec tsx scripts/gen-digest-fixtures.ts ~/code/agentcanvas
# agentcanvas: 92196 bytes, 628 files, 5915 ms
# hyperfine: 39199 bytes, 75 files, 4478 ms   (two-step fetch; commits_scanned 200)
```
