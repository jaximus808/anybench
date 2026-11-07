# Node 22 for offline, zero-dependency kit repos (TDM-128)

What we learned building `kits/tandem-vs-claude-code`, whose starting repos run TypeScript with no
`npm install` and whose graders must run offline.

## Type stripping is on by default in the `node:22` image

```
$ docker run --rm node:22 node -e 'console.log(process.version, process.features.typescript)'
v22.23.4 strip
$ node -e 'console.log(process.version, process.features.typescript)'   # local Mac
v26.0.0 strip
```

So `node src/main.ts` and `node --test "test/**/*.test.ts"` work with zero dependencies, as long as
the code is erasable TypeScript (no `enum`, parameter properties or `namespace`) and local imports
keep the `.ts` extension (`tsconfig`: `allowImportingTsExtensions`, `erasableSyntaxOnly`).

## `node --test` takes files or globs, not directories

```
$ node --test test/
Error: Cannot find module '.../input/test'
$ node --test "test/**/*.test.ts"
ℹ pass 2
```

## A synchronous throw in a `node:http` handler crashes the server

`Promise.resolve(handler(ctx)).catch(...)` does not catch a handler that throws before returning a
promise; the process dies with the uncaught error and the client's `fetch` hangs. Wrap as
`Promise.resolve().then(() => handler(ctx)).catch(...)`.

## Per-test results from `node --test`

A custom reporter (`--test-reporter=./reporter.mjs --test-reporter-destination=out.jsonl`, an async
generator over `test:pass` / `test:fail` events) gives one line per test, alongside
`--test-reporter=spec` for humans. A test file that fails to import reports no per-test events, so
the grader scores against a manifest (`tests.json`) and counts anything unreported as failed.

## `git revert -q` does not exist (git 2.39 in `node:22`)

```
$ git revert --no-edit -q HEAD
error: unknown switch `q'
```

Use `git revert --no-edit HEAD >/dev/null`.

## Latency inside Docker on a busy Mac is not a benchmark

The todo-api oracle's p95 at 50 req/s measured 305 ms on the host and 224 ms to 4.6 s across runs in `node:22`
under Docker while the host load average was ~40–55 (10 Docker CPUs, many parallel workers). The
`api-load` gate only proves it measures after correctness; real numbers come from eval computers.
