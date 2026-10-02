-- Where a connector sign-in was started (cli | cockpit | chat | portal), so
-- the unauthenticated callback can send the person back to it. Nullable: a
-- flow already under way when this lands has no value and reads as cli.
ALTER TABLE "connector_oauth_states" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD COLUMN "origin" text;--> statement-breakpoint
-- A closed circuit breaker has no "opened at". Closing used to leave the
-- stamp of the last trip behind, so a healthy connector still carried the
-- time it last failed. The engine now clears it on close; this clears the
-- stamps left on breakers that are already closed.
UPDATE "connectors"
SET "circuit_opened_at" = NULL
WHERE "circuit_state" = 'closed'
  AND "circuit_opened_at" IS NOT NULL;
