ALTER TYPE "subkit"."execution_status" ADD VALUE 'uncertain' BEFORE 'succeeded';--> statement-breakpoint
ALTER TYPE "subkit"."scheduler_sweep_producer" ADD VALUE 'notes';--> statement-breakpoint
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
ALTER TABLE "knowledge_sources" DROP COLUMN "refresh_webhook_secret";--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD CONSTRAINT "tool_approval_rules_source_quote_check" CHECK ("tool_approval_rules"."source_quote" IS NULL OR char_length("tool_approval_rules"."source_quote") BETWEEN 1 AND 400);