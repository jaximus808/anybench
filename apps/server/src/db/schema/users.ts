import { bigint, boolean, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, idPk, tstz, updatedAt } from "./_shared.js";

export const users = pgTable("users", {
  id: idPk(),
  githubLogin: text("github_login").notNull().unique(),
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  githubCreatedAt: tstz("github_created_at"),
  email: text("email"),
  /** Cache only: admin is decided per request from ADMIN_GITHUB_LOGINS. */
  isAdminCache: boolean("is_admin_cache").notNull().default(false),
  /** Settings: a proven run leaves awaiting_go on its own (no Go click) unless the create says otherwise. */
  autoStartRuns: boolean("auto_start_runs").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
