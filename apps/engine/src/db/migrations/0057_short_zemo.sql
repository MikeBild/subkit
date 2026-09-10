ALTER TABLE "executions" ADD COLUMN "tool_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "tool_approval_dispatches" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "executions_single_tool_approval_uidx" ON "executions" USING btree ("tool_approval_id") WHERE "executions"."tool_approval_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_tool_approval_shape_check" CHECK ("executions"."tool_approval_id" IS NULL OR
      ("executions"."source_kind" = 'saved' AND "executions"."workflow_id" IS NOT NULL AND
       "executions"."workflow_version_id" IS NOT NULL AND "executions"."execution_authority_id" IS NULL AND NOT "executions"."hold_writes"));