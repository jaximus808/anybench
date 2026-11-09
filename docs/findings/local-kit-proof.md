# Local kit proof in Docker (`anybench kit proof`, TDM-219)

`runLocalProof` in `packages/kit/src/local-proof/` generalises
`kits/tandem-vs-claude-code/scripts/verify-proof.sh`: two `docker run --rm --network none` containers
(`node:22` by default), the subject side mounted with the kit minus `gates/` and `reference/`, the
scoring side with only those. Checks: the oracle passes every gate it covers, and the untouched
starting workspace (no driver at all) fails a gate, on every workload.

## A fresh coding-agent scaffold (2026-11-08, Docker 29.4.3, macOS, 10 CPUs)

```
$ node --input-type=module -e 'const k = await import("./packages/kit/dist/index.js"); await k.scaffoldKit("/tmp/k1");
  console.log(JSON.stringify(await k.runLocalProof("/tmp/k1", { onLog: console.log }), null, 1))'
[proof] oracle slugify: setup
[proof] oracle slugify: driver
[proof] do-nothing slugify: setup
[proof] trials done
[proof] oracle slugify: gate hidden-tests
[proof] do-nothing slugify: gate hidden-tests
[proof] gates done
  ... "status": "pass"
  oracle_passes    pass  "hidden-tests: 7/7 hidden tests pass on slugify"
  do_nothing_fails pass  "hidden-tests: 0/7 hidden tests pass on slugify (7 failed, exit 1)"
  "durationMs": 9111
```

About 9 s on an idle daemon. With other workers' containers on the same daemon the same test took
~70 s, so the Docker tests use 5 to 10 minute timeouts.

## The curated Tandem kit, through the generic runner

```
$ node try2.mjs kits/tandem-vs-claude-code     # runLocalProof on the curated kit
oracle_passes     FAIL  hidden-tests on todo-api / auth-refactor / bug-hunt: "the outputs have no workspace/"
do_nothing_fails  pass  0/16, 0/14, 0/12 hidden tests; api-load "no latency without correctness" or not applicable
```

Its `proof/oracle/driver.sh` applies the solution to `$EVAL_WS` but does not freeze it to
`$EVAL_OUT/workspace`; its own `proof-in-container.sh` copies the workspace into the gate's
`$AB_RUN_DIR` itself. The generic runner follows the trial path (gates see `EVAL_OUT` only), so an
uploaded kit's oracle must freeze the workspace like the coding-agent template's does. The curated
kit keeps its committed PROOF.md as its proof record (orchestrator/proof-score.ts), so nothing
changes for it.
