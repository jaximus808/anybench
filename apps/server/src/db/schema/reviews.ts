import { doublePrecision, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agentSessions } from "./agent_sessions.js";
import { createdAt, idPk } from "./_shared.js";
import { trials } from "./trials.js";
import { users } from "./users.js";

/** Reviewer agent scores per trial and criterion, with quoted evidence. RLS: owner only. */
export const reviews = pgTable(
  "reviews",
  {
    id: idPk(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    trialId: uuid("trial_id")
      .notNull()
      .references(() => trials.id, { onDelete: "cascade" }),
    criterion: text("criterion").notNull(),
    score: doublePrecision("score").notNull(),
    evidence: jsonb("evidence"),
    reviewSessionId: uuid("review_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [index("reviews_trial_id_idx").on(t.trialId), index("reviews_owner_id_idx").on(t.ownerId)],
);
