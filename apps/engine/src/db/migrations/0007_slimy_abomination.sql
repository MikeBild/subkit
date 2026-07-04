ALTER TABLE "connector_document_chunks" ADD COLUMN "embedding" real[];--> statement-breakpoint
ALTER TABLE "connector_document_chunks" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding" real[];--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_model" text;