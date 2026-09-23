ALTER TABLE "executions" DROP CONSTRAINT "executions_authority_link_shape_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_turn_error" jsonb;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_authority_link_shape_check" CHECK (("executions"."authority_root_execution_id" IS NULL) = ("executions"."authority_call_path" IS NULL) AND
      ("executions"."authority_root_execution_id" IS NULL OR (
        "executions"."execution_authority_id" IS NULL AND "executions"."tool_approval_id" IS NULL AND
        NOT "executions"."hold_writes" AND "executions"."source_kind" = 'saved' AND
        "executions"."workflow_id" IS NOT NULL AND "executions"."workflow_version_id" IS NOT NULL AND
        "executions"."parent_execution_id" IS NOT DISTINCT FROM "executions"."authority_root_execution_id" AND
        jsonb_typeof("executions"."authority_call_path") = 'array' AND
        jsonb_array_length("executions"."authority_call_path") >= 1)));