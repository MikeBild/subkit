ALTER TABLE "tasks" ADD COLUMN "source_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "subkit"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_message_id_conversation_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "subkit"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_tenant_source_conversation_idx" ON "tasks" USING btree ("tenant_id","source_conversation_id") WHERE "tasks"."source_conversation_id" IS NOT NULL;