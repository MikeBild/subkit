ALTER TYPE "subkit"."credential_mode" ADD VALUE 'structured';--> statement-breakpoint
ALTER TABLE "vault_items" DROP CONSTRAINT "vault_items_kind_check";--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "origins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "value_digest" text;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_personal_only_check" CHECK ("vault_items"."kind" NOT IN ('card', 'bank_account', 'identity') OR "vault_items"."owner_user_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_origins_login_check" CHECK ("vault_items"."kind" = 'login' OR cardinality("vault_items"."origins") = 0);--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_value_digest_check" CHECK ("vault_items"."value_digest" IS NULL OR "vault_items"."value_digest" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_kind_check" CHECK ("vault_items"."kind" IN ('connector', 'secret', 'login', 'template_client', 'card', 'bank_account', 'identity', 'address', 'note'));