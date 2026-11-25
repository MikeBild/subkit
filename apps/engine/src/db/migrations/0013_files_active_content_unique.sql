DROP INDEX "files_tenant_sha256_uq";--> statement-breakpoint
CREATE INDEX "files_tenant_sha256_idx" ON "files" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "files_tenant_sha256_uq" ON "files" USING btree ("tenant_id","sha256") WHERE "files"."deleted_at" IS NULL;