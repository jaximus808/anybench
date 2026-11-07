// TDM-34: regenerate the committed digest fixtures (hits the network for the public repo).
//   pnpm --filter @anybench/kit exec tsx scripts/gen-digest-fixtures.ts && pnpm exec prettier --write packages/kit/fixtures/digests
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ingestGitHubRepo,
  ingestLocalRepo,
  serializeRepoIngest,
  type RepoIngest,
} from "../src/index.js";

const out = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/digests/${name}.json`, import.meta.url));

const jobs: Array<[string, () => Promise<RepoIngest>]> = [
  ["agentcanvas", () => ingestLocalRepo("/Users/jaxon/coding-project/agentcanvas")],
  ["hyperfine", () => ingestGitHubRepo("https://github.com/sharkdp/hyperfine")],
];

for (const [name, run] of jobs) {
  const t0 = Date.now();
  const result = await run();
  const bytes = serializeRepoIngest(result);
  await writeFile(out(name), bytes);
  console.log(
    `${name}: ${bytes.length} bytes, ${result.digest.files.count} files, ${Date.now() - t0} ms`,
  );
}
