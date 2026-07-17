-- Drop the FK under BOTH possible names: production (migrated from the original
-- 0024_mcp_oauth.sql) carries the postgres auto-name "..._fkey"; a fresh DB from
-- the v6 baseline carries drizzle's "..._fk". IF EXISTS makes this safe on both —
-- otherwise a stale NO ACTION "..._fkey" survives and keeps blocking the
-- mcp_oauth_cleanup refresh-token sweep (the bug this migration fixes).
ALTER TABLE "mcp_oauth_access_tokens" DROP CONSTRAINT IF EXISTS "mcp_oauth_access_tokens_refresh_token_id_mcp_oauth_refresh_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_tokens" DROP CONSTRAINT IF EXISTS "mcp_oauth_access_tokens_refresh_token_id_fkey";
--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_tokens" ADD CONSTRAINT "mcp_oauth_access_tokens_refresh_token_id_mcp_oauth_refresh_tokens_id_fk" FOREIGN KEY ("refresh_token_id") REFERENCES "public"."mcp_oauth_refresh_tokens"("id") ON DELETE set null ON UPDATE no action;