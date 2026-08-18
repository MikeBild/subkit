CREATE TABLE "cli_notification_inbox_reads" (
	"tenant_id" uuid NOT NULL,
	"inbox_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_notification_inbox_reads_inbox_id_user_id_pk" PRIMARY KEY("inbox_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "cli_notification_inbox" ADD COLUMN "actionable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_notification_inbox" ADD COLUMN "resource_type" text;--> statement-breakpoint
ALTER TABLE "cli_notification_inbox" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "cli_notification_inbox_reads" ADD CONSTRAINT "cli_notification_inbox_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_notification_inbox_reads" ADD CONSTRAINT "cli_notification_inbox_reads_inbox_id_cli_notification_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."cli_notification_inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_notification_inbox_reads" ADD CONSTRAINT "cli_notification_inbox_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cli_notification_inbox_reads_user_idx" ON "cli_notification_inbox_reads" USING btree ("tenant_id","user_id","inbox_id");--> statement-breakpoint
CREATE INDEX "cli_notification_inbox_actionable_idx" ON "cli_notification_inbox" USING btree ("tenant_id","id") WHERE "cli_notification_inbox"."actionable";