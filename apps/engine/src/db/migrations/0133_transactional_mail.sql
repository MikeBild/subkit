CREATE TABLE "transactional_mail_receipts" (
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactional_mail_receipts_tenant_id_workflow_id_request_id_pk" PRIMARY KEY("tenant_id","workflow_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "transactional_mail_receipts" ADD CONSTRAINT "transactional_mail_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_mail_receipts" ADD CONSTRAINT "transactional_mail_receipts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "subkit"."workflows"("id") ON DELETE cascade ON UPDATE no action;