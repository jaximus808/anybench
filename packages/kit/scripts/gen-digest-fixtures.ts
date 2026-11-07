// TDM-34: regenerate the committed digest fixtures (hits the network for the public repo).
//   pnpm --filter @anybench/kit exec tsx scripts/gen-digest-fixtures.ts [path/to/agentcanvas]
//   pnpm exec prettier --write packages/kit/fixtures/digests
// The agentcanvas checkout defaults to `../agentcanvas` next to the repo root. It is read-only.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestGitHubRepo,
  ingestLocalRepo,
  serializeRepoIngest,
  type RepoIngest,
} from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const agentcanvas = resolve(process.argv[2] ?? resolve(repoRoot, "../agentcanvas"));

const out = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/digests/${name}.json`, import.meta.url));

const jobs: Array<[string, () => Promise<RepoIngest>]> = [
  ["agentcanvas", () => ingestLocalRepo(agentcanvas)],
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
