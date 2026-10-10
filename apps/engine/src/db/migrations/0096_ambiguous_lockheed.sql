ALTER TABLE "subkit"."intake_collections" ADD COLUMN "creation_request_digest" text NOT NULL;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD COLUMN "creation_request_digest" text NOT NULL;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_items" ADD COLUMN "source_title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_items" ADD COLUMN "source_url" text NOT NULL;