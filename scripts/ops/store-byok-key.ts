// Store a user's BYOK Anthropic key from a shell (TDM-212): the key every trial of their
// AB_TOKEN_SOURCE=anthropic_key runs uses (kits/tandem-long-horizon).
//
//   pnpm tsx scripts/ops/store-byok-key.ts --owner <github-login | user-id> [--dry-run]
//   node --env-file=.env --import tsx scripts/ops/store-byok-key.ts --owner <login> [--dry-run]
//
// Run from the repo root. Reads ANTHROPIC_API_KEY, ANYBENCH_KEK and DATABASE_URL_DIRECT (or
// DATABASE_URL) from the environment; .env in the cwd fills anything unset, the same way the
// server loads it. Every import goes through apps/server, so its node_modules (drizzle-orm) resolve
// from the repo root (TDM-234). The key is sealed with
// envelope encryption (apps/server/src/lib/byok.ts) into user_secrets (provider `anthropic`),
// replacing any earlier one, then read back and decrypted once to prove the KEK opens it. Only the
// key's last 4 characters are ever printed.
import { loadDotEnv } from "../../apps/server/src/boot.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { createDb } from "../../apps/server/src/db/client.js";
import {
  ANTHROPIC_PROVIDER,
  findSecretOwner,
  loadUserSecret,
  storeUserSecret,
} from "../../apps/server/src/lib/byok.js";

function usage(): never {
  console.error(
    "usage: pnpm tsx scripts/ops/store-byok-key.ts --owner <github-login | user-id> [--dry-run]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--owner");
  const owner = oi >= 0 ? args[oi + 1] : undefined;
  if (!owner || owner.startsWith("-")) usage();
  const dryRun = args.includes("--dry-run");

  loadDotEnv();
  const config = loadConfig(process.env);
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  if (!config.ANYBENCH_KEK) throw new Error("ANYBENCH_KEK is not set");
  const h = createDb(config.databaseUrlDirect, { max: 1 });
  try {
    const user = await findSecretOwner(h.db, owner);
    if (!user) throw new Error(`no user '${owner}'`);
    if (dryRun) {
      console.log(JSON.stringify({ owner: user.login, user_id: user.id, dry_run: true }));
      return;
    }
    const { last4 } = await storeUserSecret(h.db, {
      kek: config.ANYBENCH_KEK,
      ownerId: user.id,
      provider: ANTHROPIC_PROVIDER,
      plaintext: key,
    });
    const back = await loadUserSecret(
      h.db,
      { current: config.ANYBENCH_KEK, previous: config.ANYBENCH_KEK_PREVIOUS },
      user.id,
      ANTHROPIC_PROVIDER,
    );
    console.log(
      JSON.stringify({
        owner: user.login,
        user_id: user.id,
        provider: ANTHROPIC_PROVIDER,
        last4,
        round_trip: back === key,
      }),
    );
    if (back !== key) process.exitCode = 1;
  } finally {
    await h.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
