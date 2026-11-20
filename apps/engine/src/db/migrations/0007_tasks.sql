DO $$
DECLARE v_schema text; v_values text;
BEGIN
 SELECT n.nspname INTO v_schema FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.oid='scheduler_sweep_producer'::regtype;
 IF EXISTS(SELECT 1 FROM pg_enum WHERE enumtypid='scheduler_sweep_producer'::regtype AND enumlabel='task') THEN RETURN; END IF;
 SELECT string_agg(quote_literal(enumlabel),',' ORDER BY enumsortorder) INTO v_values FROM pg_enum WHERE enumtypid='scheduler_sweep_producer'::regtype;
 EXECUTE format('ALTER TYPE %I.scheduler_sweep_producer RENAME TO scheduler_sweep_producer_previous',v_schema);
 EXECUTE format('CREATE TYPE %I.scheduler_sweep_producer AS ENUM (%s,%L)',v_schema,v_values,'task');
 EXECUTE format('ALTER TABLE subkit.scheduler_sweep_cursors ALTER COLUMN producer TYPE %I.scheduler_sweep_producer USING producer::text::%I.scheduler_sweep_producer',v_schema,v_schema);
 EXECUTE format('DROP TYPE %I.scheduler_sweep_producer_previous',v_schema);
END $$;
--> statement-breakpoint
INSERT INTO "scheduler_sweep_cursors" ("producer") VALUES ('task') ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"environment" "execution_mode" NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"max_runs" integer,
	"reserved_runs" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"workflow_authority_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "task_grants_fingerprint_check" CHECK ("task_grants"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "task_grants_window_check" CHECK ("task_grants"."valid_until" IS NULL OR "task_grants"."valid_until" > "task_grants"."valid_from"),
	CONSTRAINT "task_grants_run_limit_check" CHECK ("task_grants"."reserved_runs" >= 0 AND ("task_grants"."max_runs" IS NULL OR ("task_grants"."max_runs" > 0 AND "task_grants"."reserved_runs" <= "task_grants"."max_runs"))),
	CONSTRAINT "task_grants_revocation_check" CHECK (("task_grants"."revoked_at" IS NULL) = ("task_grants"."revoked_by" IS NULL)),
	CONSTRAINT "task_grants_authorities_check" CHECK (jsonb_typeof("task_grants"."workflow_authority_ids") = 'array' AND jsonb_array_length("task_grants"."workflow_authority_ids") <= 200 AND octet_length("task_grants"."workflow_authority_ids"::text) <= 8192)
);
--> statement-breakpoint
ALTER TABLE "task_grants" DROP CONSTRAINT IF EXISTS "task_grants_authorities_check";
--> statement-breakpoint
ALTER TABLE "task_grants" ADD CONSTRAINT "task_grants_authorities_check" CHECK (jsonb_typeof("task_grants"."workflow_authority_ids") = 'array' AND jsonb_array_length("task_grants"."workflow_authority_ids") <= 200 AND octet_length("task_grants"."workflow_authority_ids"::text) <= 8192);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"task_revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"conversation_id" uuid,
	"trigger" text NOT NULL,
	"started_by" uuid,
	"grant_id" uuid,
	"state" text NOT NULL,
	"waiting_reason" text,
	"next_check_at" timestamp with time zone,
	"sleep_reason" text,
	"deadline_at" timestamp with time zone NOT NULL,
	"turns_used" integer DEFAULT 0 NOT NULL,
	"no_progress_count" integer DEFAULT 0 NOT NULL,
	"last_seen_turn_id" uuid,
	"last_seen_turn_seq" integer DEFAULT 0 NOT NULL,
	"turn_job_failures" integer DEFAULT 0 NOT NULL,
	"budget_wait_tokens" integer,
	"rejected_playbook_revision" integer,
	"last_playbook_revision" integer DEFAULT 0 NOT NULL,
	"trace_id" text NOT NULL,
	"failure_code" text,
	"result_ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_runs_trigger_check" CHECK ("task_runs"."trigger" IN ('manual', 'once', 'cron')),
	CONSTRAINT "task_runs_state_check" CHECK ("task_runs"."state" IN ('running', 'waiting', 'sleeping', 'result_ready', 'completed', 'aborted', 'failed')),
	CONSTRAINT "task_runs_waiting_reason_check" CHECK ("task_runs"."waiting_reason" IS NULL OR "task_runs"."waiting_reason" IN ('question', 'approval', 'no_progress', 'budget', 'question_expired', 'ai_access', 'turn_stopped')),
	CONSTRAINT "task_runs_sleep_reason_check" CHECK ("task_runs"."sleep_reason" IS NULL OR char_length("task_runs"."sleep_reason") <= 200),
	CONSTRAINT "task_runs_failure_code_check" CHECK ("task_runs"."failure_code" IS NULL OR char_length("task_runs"."failure_code") <= 200),
	CONSTRAINT "task_runs_fingerprint_check" CHECK ("task_runs"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "task_runs_trace_id_check" CHECK ("task_runs"."trace_id" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "task_runs_counters_check" CHECK ("task_runs"."task_revision" >= 1 AND "task_runs"."turns_used" >= 0 AND "task_runs"."no_progress_count" >= 0 AND "task_runs"."last_playbook_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'other' NOT NULL,
	"description_source" text DEFAULT 'llm' NOT NULL,
	"category_source" text DEFAULT 'llm' NOT NULL,
	"catalog_input_hash" text,
	"catalog_described_at" timestamp with time zone,
	"owner_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"done_when" text NOT NULL,
	"plan" jsonb NOT NULL,
	"bindings" jsonb NOT NULL,
	"environment" "execution_mode" NOT NULL,
	"schedule_cron" text,
	"schedule_timezone" text,
	"schedule_run_at" timestamp with time zone,
	"last_claimed_at" timestamp with time zone,
	"admission_hold_reason" text,
	"admission_hold_since" timestamp with time zone,
	"schedule_anchor_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by" uuid,
	"paused_reason" text,
	"max_turns" integer DEFAULT 20 NOT NULL,
	"run_deadline_minutes" integer DEFAULT 240 NOT NULL,
	"fingerprint" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"locale" text DEFAULT 'de' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_category_format" CHECK ("tasks"."category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("tasks"."category") <= 40),
	CONSTRAINT "tasks_catalog_sources" CHECK ("tasks"."description_source" IN ('human', 'llm') AND "tasks"."category_source" IN ('human', 'llm')),
	CONSTRAINT "tasks_lifecycle_check" CHECK ("tasks"."lifecycle" IN ('active', 'archived')),
	CONSTRAINT "tasks_locale_check" CHECK ("tasks"."locale" IN ('de', 'en')),
	CONSTRAINT "tasks_fingerprint_check" CHECK ("tasks"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tasks_revision_check" CHECK ("tasks"."revision" >= 1),
	CONSTRAINT "tasks_limits_check" CHECK ("tasks"."max_turns" >= 1 AND "tasks"."run_deadline_minutes" >= 1),
	CONSTRAINT "tasks_documents_check" CHECK (jsonb_typeof("tasks"."plan") = 'object' AND jsonb_typeof("tasks"."bindings") = 'object'),
	CONSTRAINT "tasks_schedule_check" CHECK ("tasks"."schedule_cron" IS NULL OR "tasks"."schedule_run_at" IS NULL),
	CONSTRAINT "tasks_admission_hold_check" CHECK (("tasks"."admission_hold_reason" IS NULL AND "tasks"."admission_hold_since" IS NULL) OR ("tasks"."admission_hold_since" IS NOT NULL AND "tasks"."admission_hold_reason" IN ('grant_required', 'grant_expired', 'grant_exhausted', 'grant_fingerprint_mismatch', 'owner_unavailable', 'ai_access_missing', 'previous_run_active', 'paused'))),
	CONSTRAINT "tasks_paused_check" CHECK (("tasks"."paused_at" IS NULL AND "tasks"."paused_by" IS NULL AND "tasks"."paused_reason" IS NULL) OR ("tasks"."paused_at" IS NOT NULL AND "tasks"."paused_reason" IN ('owner_request', 'admin', 'owner_unavailable')))
);
--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN IF NOT EXISTS "last_seen_turn_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN IF NOT EXISTS "turn_job_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN IF NOT EXISTS "budget_wait_tokens" integer;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN IF NOT EXISTS "rejected_playbook_revision" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "schedule_anchor_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "admission_hold_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "admission_hold_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "locale" text DEFAULT 'de' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_locale_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_locale_check" CHECK ("tasks"."locale" IN ('de', 'en'));--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_admission_hold_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_admission_hold_check" CHECK (("tasks"."admission_hold_reason" IS NULL AND "tasks"."admission_hold_since" IS NULL) OR ("tasks"."admission_hold_since" IS NOT NULL AND "tasks"."admission_hold_reason" IN ('grant_required', 'grant_expired', 'grant_exhausted', 'grant_fingerprint_mismatch', 'owner_unavailable', 'ai_access_missing', 'previous_run_active', 'paused')));--> statement-breakpoint
ALTER TABLE "task_runs" DROP CONSTRAINT IF EXISTS "task_runs_waiting_reason_check";--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_waiting_reason_check" CHECK ("task_runs"."waiting_reason" IS NULL OR "task_runs"."waiting_reason" IN ('question', 'approval', 'no_progress', 'budget', 'question_expired', 'ai_access', 'turn_stopped'));--> statement-breakpoint
ALTER TABLE "task_grants" DROP CONSTRAINT IF EXISTS "task_grants_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "task_grants" ADD CONSTRAINT "task_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_grants" DROP CONSTRAINT IF EXISTS "task_grants_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_grants" ADD CONSTRAINT "task_grants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "subkit"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" DROP CONSTRAINT IF EXISTS "task_runs_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" DROP CONSTRAINT IF EXISTS "task_runs_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "subkit"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" DROP CONSTRAINT IF EXISTS "task_runs_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "subkit"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_grants_tenant_id_key" ON "task_grants" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_grants_tenant_task_idx" ON "task_grants" USING btree ("tenant_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_grants_one_unrevoked_key" ON "task_grants" USING btree ("tenant_id","task_id","environment") WHERE "task_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_runs_tenant_id_key" ON "task_runs" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_runs_tenant_task_created_idx" ON "task_runs" USING btree ("tenant_id","task_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_runs_tenant_conversation_idx" ON "task_runs" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_runs_one_run_per_conversation_key" ON "task_runs" USING btree ("tenant_id","conversation_id") WHERE "task_runs"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_runs_one_open_run_key" ON "task_runs" USING btree ("tenant_id","task_id") WHERE "task_runs"."state" IN ('running', 'waiting', 'sleeping');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_runs_tenant_wake_idx" ON "task_runs" USING btree ("tenant_id","next_check_at") WHERE "task_runs"."state" = 'sleeping';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_tenant_id_key" ON "tasks" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_tenant_owner_idx" ON "tasks" USING btree ("tenant_id","owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_tenant_category_idx" ON "tasks" USING btree ("tenant_id","category");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_tasks() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."goal"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."done_when"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."plan"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."bindings"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."schedule_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."schedule_timezone"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."admission_hold_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."paused_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."lifecycle"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."goal"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."done_when"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."plan"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."bindings"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."schedule_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."schedule_timezone"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."admission_hold_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."paused_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."lifecycle"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'tasks',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER hosted_meter_tasks AFTER INSERT OR UPDATE OR DELETE ON subkit."tasks" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_tasks();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['tasks'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."goal"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."done_when"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."plan"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."bindings"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."schedule_cron"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."schedule_timezone"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."admission_hold_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."paused_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."fingerprint"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."lifecycle"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."tasks" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id AND NOT (u.resource_counts ? 'tasks');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_operational_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE j jsonb; field record; valid boolean:=true;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM subkit.tenants WHERE id=NEW.tenant_id AND origin='self_service') THEN RETURN NEW; END IF;
 j:=to_jsonb(NEW);
 FOR field IN SELECT key,value FROM jsonb_each_text(j) LOOP
  IF field.value IS NULL THEN CONTINUE; END IF;
  IF field.key IN ('error') AND TG_TABLE_NAME IN ('llm_usage','external_call_metering') THEN
   NEW.error:='provider_error';
  ELSIF field.key IN ('token_sha256','code_sha256','subject_sha256','state_sha256','evidence_sha256','actor_hmac','session_hmac') THEN
   valid:=valid AND field.value ~ '^[0-9a-f]{64}$';
  ELSIF field.key IN ('redirect_uri','authorization_url','authorization_endpoint','token_endpoint','registration_endpoint','as_issuer','issuer_url','base_url','resource') THEN
   valid:=valid AND octet_length(field.value)<=4096 AND field.value !~ '[[:cntrl:]]';
  ELSIF field.key='redirect_to' THEN
   valid:=valid AND octet_length(field.value)<=2048 AND field.value ~ '^/' AND field.value !~ '[[:cntrl:]]';
  ELSIF field.key IN ('state','code_verifier','nonce','code_challenge','prefix','platform_event_id','standard_webhook_id','drain_boot_id') THEN
   valid:=valid AND octet_length(field.value)<=256 AND field.value ~ '^[A-Za-z0-9._:/+@=-]+$';
  ELSIF jsonb_typeof(j->field.key)='string' THEN
   valid:=valid AND octet_length(field.value)<=512 AND field.value !~ '[[:cntrl:]]';
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='hosted_storage_objects' THEN
  valid:=valid AND octet_length(j->>'storage_key')<=160
   AND j->>'storage_key' ~ ('^offload/'||NEW.tenant_id::text||'/([0-9a-f-]{36}/)?[0-9a-f-]{36}[.]json$')
   AND j->>'storage_namespace' ~ '^[0-9a-f]{64}$';
 ELSIF TG_TABLE_NAME='llm_usage' THEN
  valid:=valid AND j->>'flow'=ANY(ARRAY['generate','extract','catalog_describe','repair','tool_repair','converse','discover','summarize','suggest_next','critic_authoring','judge','workflow_step'])
   AND j->>'result'=ANY(ARRAY['success','quota_exhausted','context_too_large','error']) AND j->>'actor_type'=ANY(ARRAY['system','user','system_account'])
   AND j->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$';
 ELSIF TG_TABLE_NAME='hosted_work_admissions' THEN
  valid:=valid AND (j->>'queue_name' IS NULL OR j->>'queue_name'=ANY(ARRAY['execution.run','conversation.run-turn','chat.event','task.run-turn']))
   AND j->>'kind'=ANY(ARRAY['execution','chat']) AND j->>'state'=ANY(ARRAY['pending','active','reconciliation_required','released']);
 ELSIF TG_TABLE_NAME='caller_budget_units' THEN
  valid:=valid AND octet_length(j->>'unit_key')<=128 AND j->>'product_id' ~ '^[a-zA-Z0-9._:-]{1,128}$'
   AND j->>'bucket' ~ '^[a-zA-Z0-9._:-]{1,128}$';
 ELSIF TG_TABLE_NAME='usage_events' THEN
  valid:=valid AND j->>'surface'=ANY(ARRAY['http','chat','mcp','conversations']) AND j->>'traffic_class'=ANY(ARRAY['organic','synthetic','internal']);
 ELSIF TG_TABLE_NAME='tenant_erasure_states' THEN
  valid:=valid AND j->>'stage'=ANY(ARRAY['claimed','queue_cleared','objects_cleared','completed'])
   AND (j->>'failure_code' IS NULL OR j->>'failure_code'=ANY(ARRAY['tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed']));
 END IF;
 IF NOT COALESCE(valid,false) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_operational_metadata_invalid'; END IF;
 RETURN NEW;
END $_$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_audit_metadata_without_provenance(p_metadata jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
BEGIN
 IF p_metadata IS NULL OR jsonb_typeof(p_metadata)<>'object' THEN RETURN NULL; END IF;
 IF (p_metadata ? 'request_source' AND (jsonb_typeof(p_metadata->'request_source')<>'string' OR NOT COALESCE(p_metadata->>'request_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'origin_source' AND (jsonb_typeof(p_metadata->'origin_source')<>'string' OR NOT COALESCE(p_metadata->>'origin_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'execution_source' AND (jsonb_typeof(p_metadata->'execution_source')<>'string' OR NOT COALESCE(p_metadata->>'execution_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'audit_trace_id' AND (jsonb_typeof(p_metadata->'audit_trace_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_trace_id' ~ '^[0-9a-f]{32}$',false)))
 OR (p_metadata ? 'api_key_id' AND (jsonb_typeof(p_metadata->'api_key_id')<>'string' OR NOT COALESCE(p_metadata->>'api_key_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'session_id' AND (jsonb_typeof(p_metadata->'session_id')<>'string' OR NOT COALESCE(p_metadata->>'session_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_used_api_key_id' AND (jsonb_typeof(p_metadata->'audit_used_api_key_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_used_api_key_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_used_session_id' AND (jsonb_typeof(p_metadata->'audit_used_session_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_used_session_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_access_type' AND (jsonb_typeof(p_metadata->'audit_access_type')<>'string' OR NOT COALESCE(p_metadata->>'audit_access_type' IN ('api_key','browser_session','mcp_oauth','token_exchange','external_bearer','portal_token','task_run'),false)))
 OR (p_metadata ? 'audit_credential_origin' AND (jsonb_typeof(p_metadata->'audit_credential_origin')<>'string' OR NOT COALESCE(p_metadata->>'audit_credential_origin'='cli_oauth_session',false)))
 OR (p_metadata ? 'audit_oauth_client_id' AND (jsonb_typeof(p_metadata->'audit_oauth_client_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_oauth_client_id' ~ '^[A-Za-z0-9._:-]{1,128}$',false))) THEN RETURN NULL; END IF;
 RETURN p_metadata-ARRAY['request_source','origin_source','execution_source','audit_trace_id','api_key_id','session_id','audit_used_api_key_id','audit_used_session_id','audit_access_type','audit_credential_origin','audit_oauth_client_id'];
END $_$;
