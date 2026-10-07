ALTER TABLE "executions" ADD COLUMN "caller_context" jsonb;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "authorization_context" jsonb;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "sensitive_result" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "issuer_url" text;--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD COLUMN "caller_context" jsonb;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD COLUMN "authorization_context" jsonb;