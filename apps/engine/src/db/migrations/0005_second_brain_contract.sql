ALTER TYPE "subkit"."execution_status" ADD VALUE 'uncertain' BEFORE 'succeeded';--> statement-breakpoint
ALTER TYPE "public"."scheduler_sweep_producer" ADD VALUE 'notes';--> statement-breakpoint
CREATE TABLE "attention_snoozes" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attention_key" text NOT NULL,
	"snoozed_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attention_snoozes_tenant_id_user_id_attention_key_pk" PRIMARY KEY("tenant_id","user_id","attention_key")
);
--> statement-breakpoint
CREATE TABLE "personal_note_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"message_id" uuid,
	"conversation_id" uuid,
	"quote_ciphertext" "bytea" NOT NULL,
	"quote_iv" "bytea" NOT NULL,
	"quote_auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"area" text NOT NULL,
	"slug" text NOT NULL,
	"origin" text NOT NULL,
	"fact_kind" text DEFAULT 'fact' NOT NULL,
	"text_ciphertext" "bytea" NOT NULL,
	"text_iv" "bytea" NOT NULL,
	"text_auth_tag" "bytea" NOT NULL,
	"abstract_ciphertext" "bytea",
	"abstract_iv" "bytea",
	"abstract_auth_tag" "bytea",
	"confirmed_at" timestamp with time zone,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archive_reason" text,
	"replaced_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_notes_area_check" CHECK ("personal_notes"."area" IN ('about', 'preferences', 'people', 'routines', 'lessons')),
	CONSTRAINT "personal_notes_slug_check" CHECK ("personal_notes"."slug" ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
	CONSTRAINT "personal_notes_origin_check" CHECK ("personal_notes"."origin" IN ('stated', 'inferred')),
	CONSTRAINT "personal_notes_fact_kind_check" CHECK ("personal_notes"."fact_kind" IN ('fact', 'preference', 'plan', 'event')),
	CONSTRAINT "personal_notes_archive_check" CHECK (("personal_notes"."archived_at" IS NULL) = ("personal_notes"."archive_reason" IS NULL) AND ("personal_notes"."archive_reason" IS NULL OR "personal_notes"."archive_reason" IN ('superseded', 'merged', 'expired', 'stale', 'contradicted', 'manual'))),
	CONSTRAINT "personal_notes_abstract_check" CHECK (("personal_notes"."abstract_ciphertext" IS NULL) = ("personal_notes"."abstract_iv" IS NULL) AND ("personal_notes"."abstract_ciphertext" IS NULL) = ("personal_notes"."abstract_auth_tag" IS NULL)),
	CONSTRAINT "personal_notes_version_check" CHECK ("personal_notes"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "workflow_autoheal_policies" ALTER COLUMN "policy" SET DEFAULT 'never-auto';--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD COLUMN "source_quote" text;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "write_dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD COLUMN "accepted_operations" jsonb;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD COLUMN "accepted_digest" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "last_personal_notes_scan_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "fts_config" "regconfig" DEFAULT 'english'::regconfig NOT NULL;--> statement-breakpoint
UPDATE "knowledge_chunks" c SET "fts_config" = 'german'::regconfig FROM "tenants" t WHERE t."id" = c."tenant_id" AND t."language" = 'de';--> statement-breakpoint
ALTER TABLE "knowledge_chunks" drop column "tsv";--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector(fts_config, (COALESCE(title, '') || ' ') || content)) STORED;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD COLUMN "save_new_notes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD COLUMN "notes_learned_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attention_snoozes" ADD CONSTRAINT "attention_snoozes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_snoozes" ADD CONSTRAINT "attention_snoozes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_sources" ADD CONSTRAINT "personal_note_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_sources" ADD CONSTRAINT "personal_note_sources_note_id_personal_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "subkit"."personal_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_sources" ADD CONSTRAINT "personal_note_sources_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "subkit"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_sources" ADD CONSTRAINT "personal_note_sources_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "subkit"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_notes" ADD CONSTRAINT "personal_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_notes" ADD CONSTRAINT "personal_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_notes" ADD CONSTRAINT "personal_notes_replaced_by_personal_notes_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "subkit"."personal_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attention_snoozes_until_idx" ON "attention_snoozes" USING btree ("tenant_id","snoozed_until");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_note_sources_note_message_key" ON "personal_note_sources" USING btree ("note_id","message_id");--> statement-breakpoint
CREATE INDEX "personal_note_sources_tenant_note_idx" ON "personal_note_sources" USING btree ("tenant_id","note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_notes_owner_address_key" ON "personal_notes" USING btree ("tenant_id","user_id","area","slug") WHERE "personal_notes"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "personal_notes_owner_idx" ON "personal_notes" USING btree ("tenant_id","user_id","archived_at");--> statement-breakpoint
CREATE INDEX "personal_notes_replaced_by_idx" ON "personal_notes" USING btree ("replaced_by");--> statement-breakpoint
CREATE INDEX "intake_items_tenant_group_idx" ON "subkit"."intake_items" USING btree ("tenant_id","group_key");--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_knowledge_sources() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."source_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."mime_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."refresh_cron"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."description_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."category_source"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."catalog_input_hash"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."tags"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."last_error"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."source_uri"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."mime_type"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."version"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."refresh_cron"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'knowledge_sources',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "knowledge_sources" DROP COLUMN "refresh_webhook_secret";--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD CONSTRAINT "tool_approval_rules_source_quote_check" CHECK ("tool_approval_rules"."source_quote" IS NULL OR char_length("tool_approval_rules"."source_quote") BETWEEN 1 AND 400);--> statement-breakpoint
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
  valid:=valid AND j->>'flow'=ANY(ARRAY['generate','extract','catalog_describe','repair','tool_repair','converse','discover','summarize','suggest_next','critic_authoring','judge','workflow_step','personal_notes'])
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
CREATE FUNCTION subkit.hosted_meter_personal_notes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."area"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."origin"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."fact_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."archive_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."text_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."text_iv"),0)::bigint + COALESCE(octet_length(OLD."text_auth_tag"),0)::bigint + COALESCE(octet_length(OLD."abstract_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."abstract_iv"),0)::bigint + COALESCE(octet_length(OLD."abstract_auth_tag"),0)::bigint); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."area"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."slug"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."origin"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."fact_kind"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."archive_reason"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."text_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."text_iv"),0)::bigint + COALESCE(octet_length(NEW."text_auth_tag"),0)::bigint + COALESCE(octet_length(NEW."abstract_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."abstract_iv"),0)::bigint + COALESCE(octet_length(NEW."abstract_auth_tag"),0)::bigint); END IF;
 IF TG_OP='INSERT' THEN v_count:=1; ELSIF TG_OP='DELETE' THEN v_count:=-1; END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'personal_notes',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER hosted_meter_personal_notes AFTER INSERT OR DELETE OR UPDATE ON subkit.personal_notes FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_personal_notes();
--> statement-breakpoint
CREATE FUNCTION subkit.hosted_meter_personal_note_sources() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(OLD."quote_ciphertext"),0)::bigint + COALESCE(octet_length(OLD."quote_iv"),0)::bigint + COALESCE(octet_length(OLD."quote_auth_tag"),0)::bigint); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(NEW."quote_ciphertext"),0)::bigint + COALESCE(octet_length(NEW."quote_iv"),0)::bigint + COALESCE(octet_length(NEW."quote_auth_tag"),0)::bigint); END IF;
 IF TG_OP='INSERT' THEN v_count:=1; ELSIF TG_OP='DELETE' THEN v_count:=-1; END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'personal_note_sources',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER hosted_meter_personal_note_sources AFTER INSERT OR DELETE OR UPDATE ON subkit.personal_note_sources FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_personal_note_sources();