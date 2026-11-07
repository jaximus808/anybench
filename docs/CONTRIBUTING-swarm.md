# Contributing as a swarm worker

Many agents build Anybench at once, each on one Tandem ticket. These rules keep them from colliding.

## Worktree flow

One ticket, one worktree, one branch. Never edit the main checkout.

```sh
git -C /Users/jaxon/coding-project/anybench worktree add ../anybench-wt/<TICKET> -b <TICKET>
cd ../anybench-wt/<TICKET>
pnpm install
pnpm -r build && pnpm -r test
```

- Stay inside your ticket's surface. Name fixtures and helpers with a ticket-unique name.
- Stage by explicit path. Never `git add -A` or `git add .`.
- Commit message: `<TICKET> [x.y]: <summary>`, a blank line, then `Co-Authored-By: Claude <noreply@anthropic.com>`.

## Merge flow (fast-forward only)

```sh
git rebase main
pnpm install && pnpm -r build && pnpm -r test
git -C /Users/jaxon/coding-project/anybench merge --ff-only <TICKET>
```

If the fast-forward fails, someone landed first: rebase again, re-run build and test, retry. Never force anything, never push.

## Lockfile conflict rule

`pnpm-lock.yaml` is generated. Never hand-merge it. On a conflict during `git rebase main`:

```sh
# During a rebase "ours" is main (the branch you are replaying onto), "theirs" is your commit.
git checkout --ours pnpm-lock.yaml   # take main's lockfile
pnpm install                         # re-resolve your package.json changes on top of it
git add pnpm-lock.yaml
git rebase --continue
```

Most dependencies are already installed by the scaffold (TDM-6), so check before adding one.

## Package layout

Every workspace package has the same shape:

- `package.json`: name `@anybench/<pkg>` (apps: `server`, `anybench`, `web`), `"type": "module"`, `exports` pointing at `./dist/index.js` and `./dist/index.d.ts`.
- `tsconfig.json`: extends `tsconfig.base.json`, covers `src/` and `test/`, no emit. Used by `typecheck` and editors.
- `tsconfig.build.json`: emits `src/` to `dist/` (tests excluded).
- `vitest.config.ts`: runs `test/**/*.test.ts` and `src/**/*.test.ts`.

Packages import each other through `dist/`, so **build before you typecheck or test a package whose dependencies changed**. `pnpm -r build` runs in dependency order. Add a `workspace:*` dependency when you import another package, and keep the graph acyclic.

## Root scripts

| Script | Does |
| --- | --- |
| `pnpm build` | `pnpm -r build` |
| `pnpm test` | `pnpm -r test` |
| `pnpm typecheck` | `pnpm -r typecheck` (needs a build first) |
| `pnpm lint` | ESLint over the repo (`eslint.config.js`) |
| `pnpm format` / `format:check` | Prettier |

CI (`.github/workflows/ci.yml`) runs install with `--frozen-lockfile`, lint, build, typecheck, test on Node 22.

## pnpm 11 notes

- Dependency build scripts are blocked unless listed under `allowBuilds` in `pnpm-workspace.yaml`. A new dependency with a postinstall fails the install with `ERR_PNPM_IGNORED_BUILDS`; add it there as `true` or `false`.
- pnpm 11 refuses very new versions (minimum release age). If it adds an entry to `minimumReleaseAgeExclude` for you, commit that change with your lockfile.
