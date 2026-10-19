CREATE TABLE "hosted_work_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"queue_name" text,
	"job_id" uuid,
	"owner_boot_id" uuid NOT NULL,
	"evidence_sha256" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_work_admissions_kind_check" CHECK ("hosted_work_admissions"."kind" IN ('execution', 'chat')),
	CONSTRAINT "hosted_work_admissions_state_check" CHECK ("hosted_work_admissions"."state" IN ('pending', 'active', 'reconciliation_required', 'released')),
	CONSTRAINT "hosted_work_admissions_job_check" CHECK (("hosted_work_admissions"."queue_name" IS NULL) = ("hosted_work_admissions"."job_id" IS NULL) AND ("hosted_work_admissions"."state" <> 'pending' OR "hosted_work_admissions"."job_id" IS NOT NULL)),
	CONSTRAINT "hosted_work_admissions_release_check" CHECK (("hosted_work_admissions"."state" = 'released') = ("hosted_work_admissions"."released_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "hosted_work_admissions" ADD CONSTRAINT "hosted_work_admissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_work_admissions_job_key" ON "hosted_work_admissions" USING btree ("tenant_id","queue_name","job_id");--> statement-breakpoint
CREATE INDEX "hosted_work_admissions_tenant_state_idx" ON "hosted_work_admissions" USING btree ("tenant_id","kind","state");