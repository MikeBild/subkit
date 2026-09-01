ALTER TABLE "execution_steps" ADD COLUMN "result_sha256" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "result_sha256" text;