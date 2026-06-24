ALTER TABLE "external_call_metering" ADD COLUMN "execution_id" uuid;--> statement-breakpoint
ALTER TABLE "external_call_metering" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "execution_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
CREATE INDEX "external_call_metering_execution_idx" ON "external_call_metering" USING btree ("tenant_id","execution_id");--> statement-breakpoint
CREATE INDEX "llm_usage_execution_idx" ON "llm_usage" USING btree ("tenant_id","execution_id");--> statement-breakpoint
CREATE INDEX "llm_usage_conversation_idx" ON "llm_usage" USING btree ("tenant_id","conversation_id");