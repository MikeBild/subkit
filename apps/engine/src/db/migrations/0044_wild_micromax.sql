DROP INDEX "runtime_config_revisions_digest_key";--> statement-breakpoint
CREATE INDEX "runtime_config_revisions_digest_idx" ON "runtime_config_revisions" USING btree ("digest");