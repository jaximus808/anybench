import { bigint, bigserial, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { agentSessions } from "./agent_sessions.js";
import { tstz } from "./_shared.js";

/** Mirror of a Naïve session transcript, resumed with afterSeq. Retention 30 days. */
export const agentEvents = pgTable(
  "agent_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    naiveSeq: bigint("naive_seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [unique("agent_events_session_seq_uq").on(t.agentSessionId, t.naiveSeq)],
);
