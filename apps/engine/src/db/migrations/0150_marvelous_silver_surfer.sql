CREATE TABLE "workflow_review_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid,
	"conversation_id" uuid NOT NULL,
	"prepared_by" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"authority_id" uuid,
	"schedule_id" uuid,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_review_receipts_status_check" CHECK ("workflow_review_receipts"."status" IN ('pending', 'completed')),
	CONSTRAINT "workflow_review_receipts_digest_check" CHECK ("workflow_review_receipts"."snapshot_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_review_receipts_completion_check" CHECK (("workflow_review_receipts"."status" = 'pending' AND "workflow_review_receipts"."completed_at" IS NULL) OR ("workflow_review_receipts"."status" = 'completed' AND "workflow_review_receipts"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "workflow_review_receipts" ADD CONSTRAINT "workflow_review_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_receipts" ADD CONSTRAINT "workflow_review_receipts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "subkit"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_receipts" ADD CONSTRAINT "workflow_review_receipts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "subkit"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_receipts" ADD CONSTRAINT "workflow_review_receipts_tenant_workflow_fk" FOREIGN KEY ("tenant_id","workflow_id") REFERENCES "subkit"."workflows"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_receipts" ADD CONSTRAINT "workflow_review_receipts_tenant_authority_fk" FOREIGN KEY ("tenant_id","authority_id") REFERENCES "subkit"."workflow_execution_authorities"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_review_receipts_tenant_workflow_idx" ON "workflow_review_receipts" USING btree ("tenant_id","workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_review_receipts_tenant_conversation_idx" ON "workflow_review_receipts" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "workflow_review_receipts_expiry_idx" ON "workflow_review_receipts" USING btree ("expires_at") WHERE "workflow_review_receipts"."status" = 'pending';