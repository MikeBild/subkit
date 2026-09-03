CREATE TABLE "conversation_hidden" (
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_hidden_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_hidden" ADD CONSTRAINT "conversation_hidden_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_hidden" ADD CONSTRAINT "conversation_hidden_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_hidden_tenant_user_idx" ON "conversation_hidden" USING btree ("tenant_id","user_id");