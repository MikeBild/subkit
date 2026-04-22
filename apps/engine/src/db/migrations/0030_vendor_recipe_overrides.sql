-- Per-tenant overrides for VendorRecipeManifest.
-- Keyed by (tenant_id, client). `override` is a shallow JSON patch applied
-- over the manifest entry in getVendorRecipe(tenant_id, client).

CREATE TABLE "vendor_recipe_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client" text NOT NULL,
  "override" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_recipe_overrides_tenant_client_uq" ON "vendor_recipe_overrides" ("tenant_id","client");
