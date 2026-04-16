-- P10: conversations history + approvals.
--
-- Two tables bolted onto the existing `conversations` cluster:
--
--   1. conversation_drafts — append-only snapshots of the draft
--      WorkflowDef after every structured mutation. Ordinal ordering
--      supports :undo (pop the newest) and visual diff.
--
--   2. approval_requests — pending human decisions for sensitive
--      tool calls. The loop pauses when a row is created and resumes
--      when its status flips to approved / rejected.

DO $$ BEGIN
  CREATE TYPE "approval_kind" AS ENUM ('commit_draft', 'external_write', 'other');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected', 'timeout');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversation_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "ordinal" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "conversation_drafts"
  ADD CONSTRAINT "conversation_drafts_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "conversation_drafts"
  ADD CONSTRAINT "conversation_drafts_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "conversation_drafts_conv_ordinal_idx"
  ON "conversation_drafts" USING btree ("conversation_id", "ordinal");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "tool_call_id" uuid,
  "kind" "approval_kind" NOT NULL,
  "summary" text NOT NULL,
  "diff" jsonb,
  "status" "approval_status" NOT NULL DEFAULT 'pending',
  "decided_by" uuid,
  "decided_at" timestamp with time zone,
  "decision_reason" text,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_tool_call_id_fk"
  FOREIGN KEY ("tool_call_id") REFERENCES "public"."conversation_tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_decided_by_users_id_fk"
  FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "approval_requests_conv_status_idx"
  ON "approval_requests" USING btree ("conversation_id", "status");
