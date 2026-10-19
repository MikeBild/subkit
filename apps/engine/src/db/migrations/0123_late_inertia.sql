CREATE TABLE "http_rate_limit_buckets" (
	"bucket_key" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "http_rate_limit_buckets_bucket_key_window_started_at_pk" PRIMARY KEY("bucket_key","window_started_at"),
	CONSTRAINT "http_rate_limit_buckets_hits_check" CHECK ("http_rate_limit_buckets"."hits" > 0)
);
--> statement-breakpoint
ALTER TABLE "tenant_erasure_states" ADD COLUMN "drain_boot_id" text;--> statement-breakpoint
ALTER TABLE "tenant_erasure_states" ADD COLUMN "drain_untracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "http_rate_limit_buckets_expiry_idx" ON "http_rate_limit_buckets" USING btree ("expires_at");