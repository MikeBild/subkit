CREATE TABLE "engine_restart_requests" (
	"key" text PRIMARY KEY NOT NULL,
	"request" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
