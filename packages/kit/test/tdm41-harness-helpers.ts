// Shared by the TDM-41 harness driver tests (not a test file itself).
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE_TDM41 = path.dirname(fileURLToPath(import.meta.url));
export const REPO_TDM41 = path.resolve(HERE_TDM41, "../../..");
export const ADAPTER_TDM41 = path.join(REPO_TDM41, "kits/tandem-vs-claude-code/adapters/tandem");
export const TOY_KIT_TDM41 = path.join(HERE_TDM41, "fixtures/harness-tdm41/kit");
export const FAKE_CLAUDE_TDM41 = path.join(HERE_TDM41, "fixtures/harness-tdm41/fake-claude");

/** The toy kit with the real Tandem adapter copied in as adapters/tandem/. */
export async function toyKitDirTdm41(): Promise<string> {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "tdm41-kit-")), "kit");
  await cp(TOY_KIT_TDM41, dir, { recursive: true });
  await mkdir(path.join(dir, "adapters"), { recursive: true });
  await cp(ADAPTER_TDM41, path.join(dir, "adapters/tandem"), { recursive: true });
  return dir;
}
