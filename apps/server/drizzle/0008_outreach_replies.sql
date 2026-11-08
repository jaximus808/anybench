CREATE TABLE "outreach_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid,
	"message_id" uuid,
	"agentmail_message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"from_email" text NOT NULL,
	"subject" text,
	"text" text,
	"received_at" timestamp with time zone NOT NULL,
	"category" text NOT NULL,
	"classified_by" text NOT NULL,
	"reason" text,
	"suppressed_email" text,
	"needs_founder" boolean DEFAULT false NOT NULL,
	"handled_at" timestamp with time zone,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_replies_agentmail_message_id_unique" UNIQUE("agentmail_message_id"),
	CONSTRAINT "outreach_replies_category_check" CHECK ("category" in ('interested', 'question', 'not_now', 'unsubscribe', 'bounce_or_auto', 'unclear')),
	CONSTRAINT "outreach_replies_classified_by_check" CHECK ("classified_by" in ('rules', 'model'))
);
--> statement-breakpoint
ALTER TABLE "outreach_replies" ADD CONSTRAINT "outreach_replies_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_replies" ADD CONSTRAINT "outreach_replies_message_id_outreach_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."outreach_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_replies_lead_id_idx" ON "outreach_replies" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "outreach_replies_received_at_idx" ON "outreach_replies" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "outreach_replies_needs_founder_idx" ON "outreach_replies" USING btree ("needs_founder") WHERE "outreach_replies"."needs_founder" and "outreach_replies"."handled_at" is null;