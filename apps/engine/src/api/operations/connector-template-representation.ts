import { z } from "@hono/zod-openapi";
import { policy } from "../../auth/policy.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { toPublicConnector } from "../../connectors/public-view.ts";
import { RecipeConnectorBindingSchema } from "../../connectors/recipe-binding.ts";
import { RECIPE_PACK_VERTICALS } from "../../connectors/recipe-packs.ts";
import type { ResolvedConnectorTemplate } from "../../connectors/template-resolver.ts";
import {
  ConnectorRecipeSchema,
  type ConnectorTemplate,
  ConnectorTemplateSchema,
} from "../../connectors/templates.ts";
import {
  type ConnectorView,
  type CreateConnectorInput,
  DriverEnum,
  EnvironmentEnum,
} from "../../connectors/types.ts";
import { CredentialMode } from "../../credentials/types.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { type Rejection, reject } from "./index.ts";

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
    driver: DriverEnum,
    environment: EnvironmentEnum,
    auth_type: CredentialMode,
    base_url: z.string().nullable(),
    dsn: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    template_slug: z.string().nullable(),
    template_name: z.string().nullable(),
    template_source: z.enum(["builtin", "tenant"]).nullable(),
    template_version: z.number().int().nullable(),
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

const MatchUrlMatchSchema = z
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

export const RecipePackVerticalParam = z.object({
  vertical: z.enum(RECIPE_PACK_VERTICALS),
});

export const RecipePackEntrySchema = z
  .object({
    template_slug: z.string().nullable(),
    recipe_slug: z.string(),
    title: z.string(),
    description: z.string(),
    category: z.string(),
    tags: z.array(z.string()),
    difficulty: z.string(),
    connectors: z.array(RecipeConnectorBindingSchema),
    sample_input: z.unknown().nullable(),
    workflow: WorkflowDefSchema,
  })
  .openapi("RecipePackEntry");

export const RecipePackResponseSchema = z
  .object({
    vertical: z.enum(RECIPE_PACK_VERTICALS),
    outcome: z.string(),
    recipes: z.array(RecipePackEntrySchema),
  })
  .openapi("RecipePackResponse");

export function adminRejection(principal: ResolvedPrincipal): Rejection | null {
  const decision = policy.adminOnly(principal);
  return decision.allowed ? null : reject.forbidden(decision.reason ?? "admin_required");
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

export function serializeConnector(view: ConnectorView): z.infer<typeof ConnectorResponseSchema> {
  const connector = toPublicConnector(view);
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
