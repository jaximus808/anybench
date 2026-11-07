// drizzle-kit config (TDM-11). Migrations run on the DIRECT (unpooled) URL: Neon's pooled URL is
// PgBouncer transaction mode, which drizzle-kit's migrator should not use. Falls back to the local
// Docker Postgres from docker-compose.dev.yml.
import { defineConfig } from "drizzle-kit";

const url =
  process.env.DATABASE_URL_DIRECT ||
  process.env.LOCAL_DATABASE_URL ||
  "postgres://anybench:anybench@localhost:55432/anybench";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
  migrations: { table: "__drizzle_migrations", schema: "drizzle" },
  verbose: true,
});
