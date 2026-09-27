ALTER TABLE "executions" ADD COLUMN "failure" jsonb;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "output_contract" text;