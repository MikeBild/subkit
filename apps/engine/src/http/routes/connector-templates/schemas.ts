// Shared Zod schemas, helpers, and serializers for the connector-
// templates REST surface. Every per-sub-resource module imports from
// here.

import { z } from "@hono/zod-openapi";
import { policy } from "../../../auth/index.ts";
import type {
  ConnectorView,
  CreateConnectorInput,
  ResolvedConnectorTemplate,
} from "../../../connectors/index.ts";
import {
  ConnectorRecipeSchema,
  type ConnectorTemplate,
  ConnectorTemplateSchema,
} from "../../../connectors/index.ts";
import { ForbiddenError } from "../../errors.ts";

export const ListResponseSchema = z
  .object({
    items: z.array(
      ConnectorTemplateSchema.safeExtend({
        source: z.enum(["builtin", "tenant"]),
        id: z.string().nullable(),
      }),
    ),
  })
  .openapi("ConnectorTemplateListResponse");

export const CreateBodySchema = ConnectorTemplateSchema.openapi("ConnectorTemplateCreateBody");

export const TemplateRowSchema = ConnectorTemplateSchema.safeExtend({
  id: z.string(),
  source: z.literal("tenant"),
}).openapi("ConnectorTemplateRow");

export const ConnectorResponseSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    display_name: z.string(),
    driver: z.string(),
    environment: z.string(),
    auth_type: z.string(),
    base_url: z.string().nullable(),
    dsn: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    template_slug: z.string().nullable(),
    template_name: z.string().nullable(),
    template_source: z.enum(["builtin", "tenant"]).nullable(),
    template_version: z.number().int().nullable(),
    // See connectors/schemas.ts for the rationale — public surface is
    // intentionally un-narrowed.
    template_snapshot: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("ConnectorFromTemplateResponse");

export const FromTemplateBody = z
  .object({
    name: z.string().min(1).optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    base_url_environment: z.string().optional(),
    ingest_now: z.boolean().optional(),
  })
  .openapi("ConnectorFromTemplateBody");

export const MatchUrlQuery = z.object({
  url: z.string().url(),
  limit: z.coerce.number().int().min(1).max(5).default(3),
});

export const MatchUrlMatchSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    driver: z.string(),
    source: z.enum(["builtin", "tenant"]),
    version: z.number().int(),
    score: z.number(),
    matched_segment: z.string(),
    description: z.string(),
    setup_instructions: z.string(),
    credential_hints: z.array(
      z.object({
        field: z.string(),
        label: z.string(),
        placeholder: z.string(),
        doc_url: z.string().nullable(),
        secret: z.boolean(),
      }),
    ),
    keywords: z.array(z.string()),
    capabilities: z.object({
      webhooks: z.boolean(),
      webhook_events: z.array(z.string()),
      rate_limits: z
        .object({
          requests_per_second: z.number(),
          burst_size: z.number(),
          recommended_backoff_ms: z.number(),
        })
        .nullable(),
    }),
  })
  .openapi("ConnectorTemplateUrlMatchItem");

export const MatchUrlResponseSchema = z
  .object({
    url: z.string(),
    matched: z.boolean(),
    matches: z.array(MatchUrlMatchSchema),
  })
  .openapi("ConnectorTemplateUrlMatchResponse");

export const SlugParam = z.object({ slug: z.string().min(1) });
export const TemplateSlugParam = z.object({ slug: z.string().min(1) });

export const TemplateOAuthCredentialBody = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  })
  .openapi("TemplateOAuthCredentialBody");

export const TemplateOAuthCredentialResponse = z
  .object({ id: z.string() })
  .openapi("TemplateOAuthCredentialResponse");

// Read-only recipe browse routes. Recipes are global
// catalog data (no tenant body), but the routes still RBAC-gate on
// `connector:read` so portal tokens with read-only scope cannot
// trivially exfiltrate the catalog roster of paying tenants without
// at least passing auth.
export const RecipeListResponseSchema = z
  .object({
    template_slug: z.string(),
    template_name: z.string(),
    recipes: z.array(ConnectorRecipeSchema),
  })
  .openapi("ConnectorTemplateRecipeListResponse");

export const RecipeSlugParam = z.object({
  slug: z.string().min(1),
  recipe_slug: z.string().min(1),
});

// Recipe packs (vertical groupings).
//
// Packs are not stored anywhere; they are computed at request time from
// recipe `category` + `tags`. Each pack matches recipes whose category
// or tag set intersects the pack's predicate set. The route returns
// the curated roster (slug-only references — operators read details
// via the per-template recipe routes / inspect_recipe MCP tool).
//
// Pack copy leads with outcome ("revoke a departing employee's access
// in <60s"), not the connector list. Pack names + outcome strings use
// the product's domain vocabulary ("connector" / "workflow").

export const RECIPE_PACK_VERTICALS = [
  "revops",
  "customer-success",
  "finance",
  "data",
  "devops",
  "security",
  "marketing",
  "hr",
] as const;
export type RecipePackVertical = (typeof RECIPE_PACK_VERTICALS)[number];

export interface PackPredicate {
  outcome: string;
  // A recipe matches when ANY of its categories OR tags appears in the
  // predicate's set.
  match_categories: string[];
  match_tags: string[];
}

export const RECIPE_PACK_PREDICATES: Record<RecipePackVertical, PackPredicate> = {
  revops: {
    outcome:
      "Stand up the lead → opportunity → close loop with the LLM doing routing, enrichment, and Slack hand-off in real time.",
    match_categories: ["crm", "marketing"],
    match_tags: ["revops", "lead", "deal"],
  },
  "customer-success": {
    outcome:
      "Detect health-score regressions and route them to the right CSM playbook before churn lands on the renewal call.",
    match_categories: ["enterprise", "support"],
    match_tags: ["customer-success", "health", "churn", "playbook"],
  },
  finance: {
    outcome:
      "Catch failed charges, dunning windows, and high-risk payments while they still have a recovery path.",
    match_categories: ["payments"],
    match_tags: ["finance", "dunning", "billing", "risk"],
  },
  data: {
    outcome:
      "Move rows between systems-of-record on a schedule with idempotent upserts and watermark state — reverse-ETL without the bespoke vendor.",
    match_categories: ["database", "analytics"],
    match_tags: ["reverse-etl", "sync", "warehouse", "data"],
  },
  devops: {
    outcome:
      "Page on-call from the right alarm tier, post the AI postmortem, open the ticket — every incident with the same first 60 seconds.",
    match_categories: ["devops", "analytics"],
    match_tags: ["devops", "incident", "deploy", "release"],
  },
  security: {
    outcome:
      "Audit IAM drift, rotate stale keys, and require human approval on the operations a single Slack message would otherwise execute.",
    match_categories: ["enterprise"],
    match_tags: ["security", "audit", "approval"],
  },
  marketing: {
    outcome:
      "Run trial nurture and campaign QA across ESP + CRM + warehouse without the seven-tab manual spreadsheet.",
    match_categories: ["marketing"],
    match_tags: ["marketing", "nurture", "campaign", "utm"],
  },
  hr: {
    outcome:
      "Onboard a new hire across Okta + Workspace + BambooHR + Slack atomically; offboard the same way without leaving an orphaned account.",
    match_categories: ["enterprise"],
    match_tags: ["hr", "onboarding", "offboarding"],
  },
};

export const RecipePackVerticalParam = z.object({
  vertical: z.enum(RECIPE_PACK_VERTICALS),
});

export const RecipePackEntrySchema = z
  .object({
    template_slug: z.string(),
    recipe_slug: z.string(),
    title: z.string(),
    category: z.string(),
    tags: z.array(z.string()),
    difficulty: z.string(),
  })
  .openapi("RecipePackEntry");

export const RecipePackResponseSchema = z
  .object({
    vertical: z.enum(RECIPE_PACK_VERTICALS),
    outcome: z.string(),
    recipes: z.array(RecipePackEntrySchema),
  })
  .openapi("RecipePackResponse");

export const ImportRequestSchema = z
  .object({
    source: z.enum([
      "postman",
      "har",
      "openapi",
      "google_discovery",
      "graphql",
      "graphql_introspection",
      "curl",
    ]),
    content: z
      .string()
      .min(1)
      .describe(
        "Inline specification content or a source-specific URL/command. URL-fetched OpenAPI and Google Discovery documents are streamed with a 50 MiB limit; specification metadata seeds the connector draft.",
      ),
    headers: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1).optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    base_url_environment: z.string().optional(),
  })
  .openapi("ConnectorSpecImportRequest");

export const ImportDraftSchema = z
  .object({
    name: z.string().optional(),
    slug: z.string().optional(),
    driver: z.string(),
    environment: z.string(),
    base_url: z.string().optional(),
    auth_type: z.string(),
    config: z.record(z.string(), z.unknown()),
  })
  .openapi("ConnectorSpecImportDraft");

export const ImportResponseSchema = z
  .object({
    draft: ImportDraftSchema,
    template_match: z
      .object({
        slug: z.string(),
        score: z.number(),
        matched_segment: z.string(),
      })
      .nullable(),
    recommended_next: z.array(z.string()),
  })
  .openapi("ConnectorSpecImportResponse");

export function requireAdmin(p: import("../../../auth/types.ts").ResolvedPrincipal): void {
  const decision = policy.adminOnly(p);
  if (!decision.allowed) throw new ForbiddenError(decision.reason ?? "admin_required");
}

export function templateAuthToConnectorAuth(
  authType: ConnectorTemplate["auth_type"],
): CreateConnectorInput["auth_type"] {
  return authType;
}

export function serializeResolvedTemplate(
  resolved: ResolvedConnectorTemplate,
): z.infer<typeof ListResponseSchema>["items"][number] {
  return {
    ...resolved.template,
    source: resolved.source,
    id: resolved.id,
    version: resolved.template.version,
  };
}

export function serializeConnector(
  connector: ConnectorView,
): z.infer<typeof ConnectorResponseSchema> {
  return {
    id: connector.id,
    tenant_id: connector.tenant_id,
    slug: connector.slug,
    display_name: connector.display_name,
    driver: connector.driver,
    environment: connector.environment,
    auth_type: connector.auth_type,
    base_url: connector.base_url,
    dsn: connector.dsn,
    config: connector.config,
    template_slug: connector.template_slug,
    template_name: connector.template_name,
    template_source: connector.template_source,
    template_version: connector.template_version,
    template_snapshot: connector.template_snapshot,
    created_at: connector.created_at.toISOString(),
    updated_at: connector.updated_at.toISOString(),
  };
}
