ALTER TABLE "tasks" ALTER COLUMN "locale" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_language_check" CHECK ("tenants"."language" IN ('de', 'en'));