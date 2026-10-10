CREATE TABLE "catalog_categories" (
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text,
	"purpose_source" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"redirect_to" text,
	"purpose_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_categories_tenant_id_name_pk" PRIMARY KEY("tenant_id","name"),
	CONSTRAINT "catalog_categories_revision_positive" CHECK ("catalog_categories"."revision" > 0),
	CONSTRAINT "catalog_categories_source_valid" CHECK ("catalog_categories"."purpose_source" IN ('human', 'llm')),
	CONSTRAINT "catalog_categories_purpose_length" CHECK (length("catalog_categories"."purpose") <= 2000),
	CONSTRAINT "catalog_categories_aliases_array" CHECK (jsonb_typeof("catalog_categories"."aliases") = 'array' AND jsonb_array_length("catalog_categories"."aliases") <= 32),
	CONSTRAINT "catalog_categories_redirect_not_self" CHECK ("catalog_categories"."redirect_to" IS NULL OR "catalog_categories"."redirect_to" <> "catalog_categories"."name")
);
--> statement-breakpoint
ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;