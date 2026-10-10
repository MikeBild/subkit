-- Custom SQL migration file, put your code below! --
ALTER TABLE "subkit"."intake_collections" ADD CONSTRAINT "intake_collections_tenant_id_key" UNIQUE ("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD CONSTRAINT "intake_items_tenant_id_key" UNIQUE ("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposals" ADD CONSTRAINT "intake_proposals_tenant_id_key" UNIQUE ("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_revisions" ADD CONSTRAINT "intake_proposal_revisions_tenant_id_key" UNIQUE ("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "subkit"."intake_collection_defaults" ADD CONSTRAINT "intake_collection_defaults_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_collections" ADD CONSTRAINT "intake_collections_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD CONSTRAINT "intake_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposals" ADD CONSTRAINT "intake_proposals_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_revisions" ADD CONSTRAINT "intake_proposal_revisions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_items" ADD CONSTRAINT "intake_proposal_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_collection_defaults" ADD CONSTRAINT "intake_collection_defaults_tenant_collection_fk" FOREIGN KEY ("tenant_id", "collection_id") REFERENCES "subkit"."intake_collections"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD CONSTRAINT "intake_items_tenant_collection_fk" FOREIGN KEY ("tenant_id", "collection_id") REFERENCES "subkit"."intake_collections"("tenant_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_revisions" ADD CONSTRAINT "intake_proposal_revisions_tenant_proposal_fk" FOREIGN KEY ("tenant_id", "proposal_id") REFERENCES "subkit"."intake_proposals"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_items" ADD CONSTRAINT "intake_proposal_items_tenant_revision_fk" FOREIGN KEY ("tenant_id", "proposal_revision_id") REFERENCES "subkit"."intake_proposal_revisions"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_items" ADD CONSTRAINT "intake_proposal_items_tenant_item_fk" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "subkit"."intake_items"("tenant_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD CONSTRAINT "intake_items_admitted_knowledge_fk" FOREIGN KEY ("admitted_knowledge_source_id") REFERENCES "subkit"."knowledge_sources"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposals" ADD CONSTRAINT "intake_proposals_confirmed_knowledge_fk" FOREIGN KEY ("confirmed_knowledge_source_id") REFERENCES "subkit"."knowledge_sources"("id") ON DELETE set null;
