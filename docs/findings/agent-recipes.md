# Agent recipes: claude-code, tandem, playwright (TDM-27 [3.6], 2026-11-08)

The recipes the `agent-cc` profile adds on top of the six base recipes (`recipes.md`), run by the
same generic runner (`packages/envs/src/recipe.ts`). This was checked on docker-local and live on Naïve.

| recipe | version | what it installs | deps |
|---|---|---|---|
| `eval-user` | 1.0.0 | the non-root user `eval` (home `/home/eval`, bash, its own group, **no sudo**) that trials run agents as | none |
| `claude-code` | 2.1.319 | `@anthropic-ai/claude-code@2.1.319` in `/opt/anybench/claude-code-2.1.319`, linked as `/usr/local/bin/claude`, configured for Naïve's Anthropic proxy (below) | node22, eval-user |
| `tandem` | 0.2.0-mcp3.2.0 | the Tandem server binary v0.2.0 as `/usr/local/bin/tandem`, plus `@jaximus/tandem-mcp@3.2.0` as `/usr/local/bin/tandem-mcp`, with the npx cache warmed for the exec user and for `eval`. Exports `TANDEM_AUTOSTART=0` and `TANDEM_BIN` | node22, eval-user, claude-code |
| `playwright` | 1.64.1-chromium | `playwright@1.64.1`, plus `playwright install --with-deps --only-shell chromium` into `PLAYWRIGHT_BROWSERS_PATH=/opt/anybench/ms-playwright` | node22, eval-user |

`AGENT_CC_RECIPES` (exported from `@anybench/envs`) is the six base recipes plus `claude-code` and
`tandem`. Playwright is not in agent-cc; the `web` profile (3.9) will pick it up.

## Pins

- **Claude Code 2.1.319** was published 2026-11-06. It is the build TDM-16
  (`claude-code-naive-proxy.md`) verified end to end against Naïve's Anthropic
  proxy. The switch that proxy needs, `CLAUDE_CODE_MODEL_CAPABILITIES`, was found in that binary, so
  this pin takes priority over the two-weeks-old rule. (The first live run below used 2.1.310.) The npm package is a thin wrapper. Its postinstall copies the
  platform's native binary (`@anthropic-ai/claude-code-linux-{x64,arm64}`, an optional dependency at
  the same version) to `bin/claude`. npm checks both tarballs against the registry's sha512
  integrity. `claude --version` prints `2.1.319 (Claude Code)`.
- **Tandem server v0.2.0** was published 2026-10-28. It is 10 days old, but it is the release
  `tandem-mcp` 3.2.0's CHANGELOG pairs with ("Pairs with Tandem server v0.2.0"), and it is the subject
  of the benchmark. The sha256 comes from the release's `SHA256SUMS`, which matches GitHub's asset digest:

  ```
  $ curl -fsSL https://github.com/jaximus808/tandem/releases/download/v0.2.0/SHA256SUMS
  5f06c0e2a7d77424054435ea6c1ebba6b100baeec68ef0ef924b86715c9182a3  tandem_linux_amd64
  2b5f2aaded3f992ba47884b81e7f1d69d28abdf8b80d0f137035f06b04f1626c  tandem_linux_arm64
  ```
- **Playwright 1.64.1** was published 2026-10-14. 1.65.0 is two days old. Chromium is the build
  that this Playwright release pins.

Bump a pin by editing recipe.json: `version`, the `*_VERSION` env and the `/opt/anybench/<name>-<ver>`
dirs, which the unit test checks against each other. No script contains `latest`, and the unit test
fails if one ever does.

## Claude Code configured for the Naïve proxy

The recipe exports TDM-16's non-secret switches. Each one was verified live on 2.1.319, and
dropping one makes the proxy's first call fail with a 400:

```
ANTHROPIC_BASE_URL=https://api.vetta.sh/v1/proxy/anthropic
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1      # else 400 unknown body field: context_management
MAX_THINKING_TOKENS=0                          # else 400 thinking.type: expected "disabled"
CLAUDE_CODE_MODEL_CAPABILITIES=-effort,-max_effort,-xhigh_effort,-per_turn_effort,-adaptive_thinking,-context_management,-rejects_disabled_thinking
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1  DISABLE_TELEMETRY=1  DISABLE_ERROR_REPORTING=1  DISABLE_AUTOUPDATER=1
```

The image holds **no secret**. Each trial gets `ANTHROPIC_AUTH_TOKEN`, a per-trial `proxy:write` key,
together with `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and
`ANTHROPIC_SMALL_FAST_MODEL` (Naïve ids such as `anthropic/claude-sonnet-4.6`). These come from the
0600 env file that TDM-16's `provisionClaudeCodeProxyEnv` writes. The
health check asserts the switches and greps the pinned binary for `CLAUDE_CODE_MODEL_CAPABILITIES`,
so a version bump that drops the switch fails the build. It makes no model call, because that needs
the trial token. A BYOK contender overrides `ANTHROPIC_BASE_URL` (and sets `ANTHROPIC_API_KEY`) in its
own trial env.

## What the Tandem binary does

```
$ docker run --rm ubuntu:24.04 … file /usr/local/bin/tandem
ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked, …, stripped
$ tandem --help        # and --version, and `version`: no CLI, every invocation starts the server
2026/11/08 03:09:18 tandem 0.2.0 — data in /root/.tandem (db /root/.tandem/tandem.db)
2026/11/08 03:09:18 Tandem listening on http://127.0.0.1:7891
$ PORT=27891 TANDEM_DATA_DIR=/tmp/td tandem & ; curl http://127.0.0.1:27891/healthz ; curl …/api/config
{"ok":true,"version":"0.2.0"}
{"auth":"none","local":true,"transcripts":true,"version":"0.2.0"}
```

- The bare binary ignores its arguments. Configure it with env only: `PORT`, `TANDEM_DATA_DIR`,
  `TANDEM_DB` (`:memory:` gives a throwaway board) and `CLAIM_TTL_MINUTES`. `up --foreground` is a
  `tandem-mcp` subcommand: `tandem-mcp up --foreground --no-open --port P --data-dir D` runs
  `$TANDEM_BIN` attached and prints `[tandem] running /usr/local/bin/tandem on http://127.0.0.1:P`.
- `tandem-mcp --version` prints `@jaximus/tandem-mcp 3.2.0` and exits. With no arguments it is the
  stdio MCP server.
- The recipe exports `TANDEM_BIN`, so `up` and the gateway's autostart never download a binary.
  `TANDEM_AUTOSTART=0` stops the gateway from starting a server on its own. The harness driver and
  the approver sidecar (4.9, 5.7) start the server themselves.

## Final live run (claude-code 2.1.319 + proxy config), 2026-11-08T03:46Z

Same command as below:

```
TDM27-LIVE computer {"id":"cmp_01a1b94364ef7a01b2a57349ff9e168c","home":"/home/naive","createMs":4054}
node22 2.9 s · python312-uv 1.9 s · git-time 12.7 s · hyperfine 0.4 s · hey 4.9 s · k6 1.0 s · eval-user 0.2 s
claude-code installed 4.2 s, healthy 0.3 s (switches set, binary knows CLAUDE_CODE_MODEL_CAPABILITIES)
tandem installed 11.3 s, healthy 3.0 s (tandem-mcp up --foreground as eval → /healthz 0.2.0)
eval-user-check (sudo -n runuser -u eval -- env -i … bash -c '…'):
  uid=1001(eval) gid=1001(eval) groups=1001(eval)
  2.1.319 (Claude Code)
  /usr/local/bin/tandem
  {"ok":true,"version":"0.2.0"}
  @jaximus/tandem-mcp 3.2.0
TDM27-LIVE destroyed {"id":"cmp_01a1b94364ef7a01b2a57349ff9e168c","lifetimeMs":106572}
 ✓ … builds base + claude-code + tandem and the eval user runs claude and tandem 107350ms
```

Cost from the ledger: **21,623 µ$** for that computer, one prorated part-block (about 235 s at
92 µ$/s for 4/8). Total Naïve spend for this ticket: **105,399 µ$ (≈ $0.105)**. That is the two earlier
4/8 builds below (one failed, one passed), this one, and the 1/1 probe. docker-local passed again on 2.1.319, 3/3 in 200 s.

## Result: live on Naïve, the agent-cc build passes (2026-11-08, first pass, claude-code 2.1.310)

```
cd packages/envs
NAIVE_LIVE=1 node --env-file=<repo>/.env ../../node_modules/vitest/vitest.mjs run agent-recipes-naive-live --reporter=verbose
```

One computer at the agent-cc size (4 vCPU / 8 GiB / 20 GB). `runRecipes(…, AGENT_CC_RECIPES)`
ran, then this check:

```
TDM27-LIVE computer {"id":"cmp_01a1b92a4265751dbaad3fb09024362f","home":"/home/naive","createMs":3176}
TDM27-LIVE system ["x86_64","Ubuntu 24.04.5 LTS","tenki","/home/tenki","/dev/root 20G 2.6G 17G 14% /","4","Mem: 7983 434 7591 …"]
node22        installed  2.1 s  health 0.3 s
python312-uv  installed  1.4 s  health 0.5 s
git-time      installed 10.9 s  health 0.2 s
hyperfine     installed  0.5 s  health 0.1 s
hey           installed  3.9 s  health 0.1 s
k6            installed  1.0 s  health 0.2 s
eval-user     installed  0.3 s  health 0.2 s
claude-code   installed  2.7 s  health 0.2 s
tandem        installed 10.4 s  health 2.7 s
```

The eval user's check ran `sudo -n runuser -u eval -- env -i HOME=/home/eval PATH=/usr/local/bin:/usr/bin:/bin TANDEM_AUTOSTART=0 bash -c '…'`:

```
uid=1001(eval) gid=1001(eval) groups=1001(eval)
2.1.310 (Claude Code)                          ← claude --version
/usr/local/bin/tandem
{"ok":true,"version":"0.2.0"}                  ← setsid tandem &, GET 127.0.0.1:7891/healthz
@jaximus/tandem-mcp 3.2.0                      ← npx --offline -y @jaximus/tandem-mcp@3.2.0 --version
```

The `tandem` health check also passed as `eval`. It starts
`npx --offline -y @jaximus/tandem-mcp@3.2.0 up --foreground --no-open --port <free> --data-dir <tmp>`,
polls `/healthz` until it sees version 0.2.0, and kills the process group. The whole build took
**about 95 s** from create to destroy. Naïve's network is fast: claude-code installs in 2.7 s
against 27 s on docker-local.

**Cost, from the ledger (`credits.ledger {type: debit}` by `resource_id`):**

| computer | what | debits µ$ |
|---|---|---|
| `cmp_01a1b92a4265751dbaad3fb09024362f` | the passing agent-cc build (4/8, 97 s) | 7,588 at create + 55,200 at the 03:20 block boundary = **62,788** |
| `cmp_01a1b92878f07badb92ceb7cf4a840b7` | first attempt (4/8, 27 s, failed on python312-uv, see below) | 18,342 |
| `cmp_01a1b9294acf7ba4b12c761fb79104e6` | 1/1 probe of the image's PATH | 2,646 |
| **total for this ticket** | | **83,776 µ$ (≈ $0.084)** |

Every computer was destroyed. The live test's `afterAll` lists the `ab-<runId>-` tag prefix and
fails if anything is left. It found nothing. The balance delta the test logs (293,484 µ$) is
higher than our debits, because other workers were spending on the same account at the same
time. The test's $1 cap is checked against that delta, so the cap is conservative.

The passing build crossed a 10-minute wall-clock boundary 1 s before its destroy, so it paid a whole
second block. A build that is snapshotted and destroyed soon after create usually pays only the prorated first block.

## Naïve image facts that broke a base recipe (fixed here)

The first live attempt failed in `python312-uv`, a TDM-25 recipe:

```
[python312-uv] error: python3.12 version: want '3.12.15', got '3.12.3'
```

A probe of the image (1 vCPU, `echo $PATH; which -a …; ls -la /usr/local/bin`) showed:

```
PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
which -a python3.12 → /opt/venv/bin/python3.12 /usr/bin/python3.12 /bin/python3.12
/usr/local/bin: bun, claude (217 MB native, preinstalled), codex, mise, opencode, pnpm, process-compose,
                node/npm/npx/corepack -> /usr/local/nvm/versions/node/v24.22.1/bin/*
sudo secure_path = /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
uid=1000(tenki); /home/naive -> /home/tenki; /home/tenki is drwxr-x--- tenki
```

- **`/opt/venv/bin` comes first on the exec PATH** and has its own `python3`/`python3.12` (3.12.3),
  so it shadows `/usr/local/bin`. The fix is in `python312-uv`: it also links `python3.12`,
  `python3`, `uv` and `uvx` into `/opt/anybench/bin` and declares `"path": ["/opt/anybench/bin"]`.
  The runner puts that dir first for later recipes, and `renderRecipeEnv` puts it first for trials.
  The health check now also asserts `command -v python3` = `/opt/anybench/bin/python3`.
- **The image already has Claude Code, node 24 (via nvm), codex, opencode and bun in `/usr/local/bin`.**
  `node22` and `claude-code` replace the `node`/`npm`/`npx`/`claude` links with the pinned builds, and
  each health check asserts the resolved path and version, so a trial never runs the image's
  unpinned copy. `codex`, `opencode` and `bun` stay where they are.
- `/home/tenki` is 0750, so `eval` cannot read the runner's scripts under `/home/naive/.anybench`.
  `as_user` (in `_lib.sh`) runs each command from the target user's own home.

## Docker-local (ubuntu:24.04, arm64)

```
$ ANYBENCH_AGENT_RECIPES_DOCKER=1 pnpm --filter @anybench/envs exec vitest run recipes-docker-tdm27
 ✓ installs claude-code, tandem and playwright and every health check passes
 ✓ a second run skips every recipe
 ✓ the eval user, with the exported env, runs claude and the tandem binary
 Test Files  1 passed (1) · Tests 3 passed (3) · Duration ~130 s
```

| recipe | install s | health s |
|---|---|---|
| node22 | 18–30 | 0.7 |
| eval-user | 0.2–0.4 | 0.2 |
| claude-code | 7–27 | 0.1–0.5 |
| tandem | 25–81 | 6.8 |
| playwright | 50–53 | 1.2–3.1 |

The Playwright health check runs as `eval`. It launches headless Chromium, `goto("about:blank")`, and
`evaluate(() => 6 * 7)` must return `about:blank 42 <chromium version>`. The test is opt-in
(`ANYBENCH_AGENT_RECIPES_DOCKER=1`), because it pulls about 400 MB and runs Chromium, which is too
heavy for every gate run on a shared Mac. Playwright has **not** run on Naïve yet. It is not part of agent-cc.

## Gotchas (all handled in `_lib.sh` / the scripts)

- **npm as root runs lifecycle scripts as the owner of the cwd.** The runner's cwd is the recipe
  dir under the exec user's home, so Claude Code's postinstall would run as `tenki` and fail to write
  the root-owned prefix. `npm_root_install` runs npm from `/`, with `HOME=/root` and root's own
  cache, so nothing root-owned lands in the exec user's `~/.npm`.
- **The npx cache is per user** (`~/.npm/_npx`). `tandem` warms it for the owner of `$HOME` (`tenki`
  on Naïve; `naive` on docker-local, where exec is root) and for `eval`, never for root. The health
  check proves it with `npx --offline`.
- **The health check's server must not hold the exec open.** It is started with `setsid` and all fds
  redirected, then killed by process group and waited on before the check exits.
- `sudo -n -E` keeps the recipe env (`TANDEM_*`, `NODE_HOME`) but replaces PATH with `secure_path`.
  `as_user` passes the caller's PATH explicitly through `runuser … env PATH=…`.

## For downstream tickets

- Run agents as `eval`: `sudo -n runuser -u eval -- env HOME=/home/eval …`, or `as_user eval …` inside
  a recipe. `ANYBENCH_EVAL_USER` and `ANYBENCH_EVAL_HOME` are exported. `eval` has no sudo, and its
  health check fails if it ever gets passwordless sudo.
- The kit (`kits/tandem-vs-claude-code`, TDM-184) pins the same `CLAUDE_CODE_VERSION=2.1.319` and
  `TANDEM_MCP_VERSION=3.2.0` that agent-cc exports, so its L1 installs are no-ops on this image.
- The MCP config a trial writes should be `{"command":"npx","args":["--offline","-y","@jaximus/tandem-mcp@3.2.0"]}`
  (or `"command":"tandem-mcp"`), with `TANDEM_AUTOSTART=0` in its env.
