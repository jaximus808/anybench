# apps/cli

anybench CLI and the /anybench Claude Code skill.

See plan.md, E6.6.

## Bring your own kit (E19)

Your own coding agent (Claude Code, Codex, Cursor) builds the eval kit on your machine, proves it
locally, and uploads it. Anybench then reruns the full proof on its own computers (an uploaded kit
is never trusted as is), runs the trials and writes the report. You pay for trial compute and your
own model tokens only.

```sh
anybench kit init my-kit                 # scaffold a KitSpec v2 kit (default template: coding-agent)
anybench kit validate my-kit             # anybench.yaml + every file it references + workload hashes
anybench kit proof my-kit                # oracle + do-nothing, locally in Docker (no agent, no tokens)
KIT=$(anybench kit push my-kit)          # pack + upload; prints the kit id
anybench run --kit "$KIT" --question "Is my setup better than plain Claude Code?" --budget 25
                                         # prints the run URL
```

| Command | What it does | Exit codes |
| --- | --- | --- |
| `kit init [dir] [--template <name>] [--force] [--json]` | Copies one of `packages/kit/examples` (`coding-agent`, `cli`, `harness`, `http-agent`) into `dir` and validates it. Refuses a non-empty `dir` without `--force`. | 0 ok · 1 refused or invalid · 2 usage |
| `kit validate [dir] [--json] [--quiet]` | KitSpec v2 schema, referenced files, exec bits, workload hashes. | 0 · 1 · 2 |
| `kit proof [dir] [--image <img>] [--network] [--timeout <s>] [--keep] [--json]` | Runs the oracle and a do-nothing contender on every workload in two `docker run --network none` containers: the subject side never sees `gates/` or `reference/`, the scoring side sees only those. Passes when the oracle passes every gate it covers and the untouched starting workspace fails a gate, on every workload. Progress goes to stderr. | 0 pass · 1 fail or invalid kit · 2 usage · 3 could not run (no Docker, no locally runnable oracle, timeout) |
| `kit push [dir] [--json]` | Validates, packs (`packKit`: regular files and dirs only, no links, size and count caps), then `POST /kits/uploads` → presigned PUT → `POST /kits/uploads/:id/complete`. stdout is the kit id alone. | 0 · 1 invalid or refused · 2 usage or no key |
| `run --kit <kit_id> --question <text> --budget <usd> [--auto-go] [--json]` | `POST /runs` with `source: {kind: "kit"}`; the budget is in dollars, converted to integer micro-USD without floats. stdout is the run URL. | 0 · 1 refused · 2 usage or no key |

The local proof needs an oracle that is a standalone `driver_patch` (a replacement driver that
applies a reference solution and freezes the workspace to `$EVAL_OUT/workspace`), like the
`coding-agent` template's `proof/oracle/driver.sh`. A kit whose oracle runs the real subject
(`cli`, `http-agent` templates) exits 3 with `not_runnable`; push it and the proof runs on Anybench
computers. Do-less overlays, the planted regression, smoke and baselines need the real
contenders, so they run only there.

Env:

- `ANYBENCH_API_KEY`: an `ab_live_…` / `ab_test_…` key with scope `runs:write` (push, run).
- `ANYBENCH_API_URL`: the API base (default the deployed API).
- `ANYBENCH_WEB_URL`: the web app for the printed run URL (default `https://anybench.jaxonp.com`).
- `ANYBENCH_PROOF_IMAGE`: the image `kit proof` uses (default `node:22`).

The logic lives in `@anybench/kit`, so the MCP server (TDM-220) calls the same functions:
`scaffoldKit(dir, {template, force})`, `runLocalProof(dir, {image, network, timeoutMs, keep, onLog})`
→ `LocalProofResult`, `packKit(dir)` → `PackedKit`, and `inspectKitArchive(bytes)` for the archive
rules.
