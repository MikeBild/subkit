ALTER TABLE "tool_approvals" ADD COLUMN "preview_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD COLUMN "preview_iv" "bytea";--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD COLUMN "preview_auth_tag" "bytea";--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD COLUMN "portal_token_sha256" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_approvals_portal_token_sha256_key" ON "tool_approvals" USING btree ("portal_token_sha256");