CREATE TYPE "public"."elicitation_status" AS ENUM('pending', 'resolved', 'cancelled', 'timeout');--> statement-breakpoint
CREATE TABLE "conversation_elicitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool_call_id" uuid,
	"tool_name" text NOT NULL,
	"summary" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"status" "elicitation_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_tool_call_id_conversation_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."conversation_tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD CONSTRAINT "conversation_elicitations_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_elicitations_conv_status_idx" ON "conversation_elicitations" USING btree ("conversation_id","status");