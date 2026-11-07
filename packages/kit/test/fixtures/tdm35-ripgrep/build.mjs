/* global fetch, URL, console */
// Rebuilds ripgrep-15.2.0.json, the committed binary-ingest fixture (TDM-35). Needs network and
// Docker; tests never run this, they read the committed JSON.
//   pnpm -C packages/kit build && node packages/kit/test/fixtures/tdm35-ripgrep/build.mjs
import { writeFile } from "node:fs/promises";
import { ingestBinary } from "../../../dist/index.js";

const url =
  "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz";
const sumRes = await fetch(`${url}.sha256`);
const expected = (await sumRes.text()).trim().split(/\s+/)[0];
const result = await ingestBinary({ url, expected_sha256: expected, name: "rg" });
await writeFile(
  new URL("./ripgrep-15.2.0.json", import.meta.url),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(result.digest.summary);
console.log(
  result.captures
    .map((c) => `${c.args.join(" ")} -> exit ${c.exit_code} ${c.stdout.length}B ${c.skipped ?? ""}`)
    .join("\n"),
);
