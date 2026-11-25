ALTER TABLE "conversations" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_visibility_idx" ON "conversations" USING btree ("tenant_id","visibility","updated_at");--> statement-breakpoint
UPDATE "conversations" AS c SET "visibility" = 'team' FROM "chat_sessions" AS s JOIN "chat_workspaces" AS w ON w."id" = s."workspace_id" WHERE s."conversation_id" = c."id" AND s."tenant_id" = c."tenant_id" AND c."surface" = 'chat' AND w."platform" = 'slack' AND s."thread_id" ~ '^C[A-Z0-9]+:root$';
