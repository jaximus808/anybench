// Programmatic migrations (tests, boot scripts). The CLI path is `pnpm --filter server db:migrate`.
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

/** apps/server/drizzle, from both src/db and dist/db. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const h = createDb(url, { max: 1 });
  try {
    await migrate(h.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await h.close();
  }
}
