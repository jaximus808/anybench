CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_tick_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticks" integer DEFAULT 0 NOT NULL
);
