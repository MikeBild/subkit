ALTER TABLE "conversation_elicitations" DROP CONSTRAINT "conversation_elicitations_decided_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_tasks" DROP CONSTRAINT "mcp_tasks_actor_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD COLUMN "decided_by_kind" "audit_actor_kind";--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD COLUMN "actor_kind" "audit_actor_kind";--> statement-breakpoint
UPDATE "conversation_elicitations" SET "decided_by_kind" = 'user' WHERE "decided_by" IS NOT NULL;--> statement-breakpoint
UPDATE "mcp_tasks" SET "actor_kind" = 'user' WHERE "actor_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_decided_by_kind_check" CHECK (("conversation_elicitations"."decided_by" IS NULL) = ("conversation_elicitations"."decided_by_kind" IS NULL) AND ("conversation_elicitations"."decided_by_kind" IS NULL OR "conversation_elicitations"."decided_by_kind" <> 'system'));--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD CONSTRAINT "mcp_tasks_actor_kind_check" CHECK (("mcp_tasks"."actor_id" IS NULL) = ("mcp_tasks"."actor_kind" IS NULL) AND ("mcp_tasks"."actor_kind" IS NULL OR "mcp_tasks"."actor_kind" <> 'system'));