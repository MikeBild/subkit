ALTER TABLE "knowledge_sources" ADD COLUMN "review_due_at" timestamp with time zone;--> statement-breakpoint
INSERT INTO "scheduler_sweep_cursors" ("producer") VALUES ('notes');