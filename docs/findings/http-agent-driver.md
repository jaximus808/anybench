# http-agent driver: getting `anybench-http-agent` onto PATH (TDM-40)

`driver.type: http-agent` kits call one command from two places:

- `adapters/<contender>/driver.sh run` on the **agent's computer** (`anybench-http-agent run`): it posts the conversation inputs and writes the transcripts and metrics to `EVAL_OUT`.
- `gates/<gate>/check.sh` on the **scoring computer** (`anybench-http-agent gate`): it scores the frozen transcripts against the labels in `gates/<gate>/reference/<workload>/`.

Both scripts run `"${ANYBENCH_HTTP_AGENT:-anybench-http-agent}"`, so the command is found on PATH by default and `ANYBENCH_HTTP_AGENT` can point at any executable instead (the kit tests point it at a `node --import tsx src/.../bin.ts` shim).

Requirements: Node >= 22 (top-level await, `AbortSignal.any`, `fetch`). The example stub agent also needs type stripping: `node --experimental-strip-types` (Node >= 22.6; it is on by default from Node 23.6).

## 1. Inside the monorepo: the package `bin`

`packages/kit/package.json` declares `"bin": {"anybench-http-agent": "./dist/drivers/http-agent/bin.js"}`. pnpm links it into the `node_modules/.bin` of every workspace package that depends on `@anybench/kit` (apps/cli, apps/server, packages/bench). The link is made at install time and points at `dist/`, so build first.

```
$ pnpm --filter @anybench/kit build
$ rm -rf apps/cli/node_modules && pnpm install --offline
Done in 1.3s using pnpm v11.2.2
$ ls -la apps/cli/node_modules/.bin/ | grep anybench
-rwxr-xr-x@ 1 jaxon  staff  816 Nov  7 16:54 anybench-http-agent
$ apps/cli/node_modules/.bin/anybench-http-agent
anybench-http-agent: missing command
usage:
  anybench-http-agent run  --in DIR --out DIR [--config FILE] [--endpoint URL] [--max-turns N] [--model ID] [--simulated-user naive]
  anybench-http-agent gate --conversations DIR --labels DIR --out DIR --verdict FILE [--oracle DIR]
$ echo $?
2
```

Two caveats seen while setting this up:

- On a fresh clone, `pnpm install` runs before `dist/` exists and prints a warning (it does not fail):
  `[WARN] Failed to create bin at .../apps/server/node_modules/.bin/anybench-http-agent. ENOENT: no such file or directory, open '.../node_modules/@anybench/kit/dist/drivers/http-agent/bin.js'`
- pnpm 11 does not relink an already-installed workspace dependency's bins on a plain `pnpm install` (`--force` did not either). Removing that package's `node_modules` and installing again links it.

## 2. On eval computers: one bundled file

The agent's and scoring computers do not have the monorepo, and `@anybench/kit` is private (its `workspace:*` deps are not published), so `npm install -g` of a packed tarball cannot resolve. A single-file bundle works and needs only Node >= 22. bun is already the bundler for the runner binary (`pnpm --filter @anybench/runner build:bin`):

```
$ ~/.bun/bin/bun --version
1.3.14
$ bun build packages/kit/dist/drivers/http-agent/bin.js --target=node --format=esm --outfile=$OUT/anybench-http-agent.mjs
  anybench-http-agent.mjs  1.19 MB  (entry point)
$ head -1 $OUT/anybench-http-agent.mjs
#!/usr/bin/env node
```

Run from a directory outside the repo, it works with no `node_modules`. Here it is driving the example kit (start, ready, run and stop, then check.sh):

```
$ export EVAL_WS=$OUT/ws ANYBENCH_HTTP_AGENT=$OUT/anybench-http-agent.mjs
$ D=packages/kit/examples/http-agent/adapters/support-bot/driver.sh
$ $D start; $D ready; $D run packages/kit/examples/http-agent/workloads/support-basics $OUT/out; $D stop
bulk-quote: completed (1 turn(s), ended by script)
order-followup: completed (2 turn(s), ended by script)
order-status: completed (1 turn(s), ended by script)
refund-eligible: completed (1 turn(s), ended by script)
refund-too-late: completed (1 turn(s), ended by script)
$ packages/kit/examples/http-agent/gates/labeled-answers/check.sh $OUT/out support-basics $OUT/gate.json
PASS: all 5 conversations match their labels (13 checks)
$ cat $OUT/gate.json
{"pass":true,"reason":"all 5 conversations match their labels (13 checks)","evidence":["labeled-answers.json"]}
```

To install it, copy the file to `/usr/local/bin/anybench-http-agent` (mode 0755) on the profile snapshot or in the kit's `install.sh`, or set `ANYBENCH_HTTP_AGENT` to wherever it was copied. No script builds this bundle yet. The worker or profile builder needs to produce it and ship it next to the runner binary (follow-up).

## 3. What the agent's computer must never get

- **Labels.** They live in `gates/<gate>/reference/<workload>/<conversation>.json`. The workload's `conversations/*.json` files are inputs only: the schema is strict, and a label key (`expect`, `expected`, `tools`, `oracle`) in a workload file is a validation error. Only the scoring computer reads `gates/`.
- **`labeled-answers.json`.** The gate writes it on the scoring computer. The example kit does not list it in `collect:`, because a file collected from `EVAL_OUT` could have been planted by the agent.
- **The answer in a simulated-user plan.** `simulated_user.goal` and `persona` are agent-visible. The simulated user's messages are written from them and posted to the agent, so they must never contain the expected answer.
