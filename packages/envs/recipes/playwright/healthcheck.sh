#!/usr/bin/env bash
# playwright: as the eval user, the pinned Playwright launches headless Chromium, opens
# about:blank and evaluates script in it.
set -euo pipefail
. "$RECIPE_LIB"

out=$(as_user "$EVAL_USER" env NODE_PATH="$ANYBENCH_PLAYWRIGHT_HOME/lib/node_modules" node -e '
  const { chromium } = require("playwright");
  const want = process.env.PLAYWRIGHT_VERSION;
  const got = require("playwright/package.json").version;
  if (got !== want) { console.error(`playwright ${got}, want ${want}`); process.exit(1); }
  (async () => {
    const b = await chromium.launch({ headless: true });
    const p = await b.newPage();
    await p.goto("about:blank");
    const v = await p.evaluate(() => 6 * 7);
    process.stdout.write(`${p.url()} ${v} ${b.version()}`);
    await b.close();
  })().catch((e) => { console.error(e); process.exit(1); });
' </dev/null)
case "$out" in
  "about:blank 42 "*) ;;
  *) die "headless chromium as $EVAL_USER: want 'about:blank 42 <version>', got '$out'" ;;
esac
echo "playwright $PLAYWRIGHT_VERSION chromium ${out##* } ok (as $EVAL_USER)"
