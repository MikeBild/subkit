// GC3: connector template registry HTTP surface.
//
// Routes:
//   GET    /v1/connector-templates                     — list built-ins + tenant overrides
//   POST   /v1/connector-templates                     — admin: add a tenant override row
//   DELETE /v1/connector-templates/:id                 — admin: remove a tenant override
//   POST   /v1/connectors/from-template/:slug          — admin: instantiate a connector
//
// Built-in templates ship with the binary (see connectors/templates.json).
// Tenant overrides live in the `connector_templates` table; tenant rows
// shadow built-ins when the slugs collide.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { policy } from "../../auth/policy.ts";
import * as connectorSvc from "../../connectors/service.ts";
import { upsertTemplateOAuthCredentials } from "../../connectors/template-credentials.ts";
import {
  listResolvedConnectorTemplates,
  type ResolvedConnectorTemplate,
  resolveConnectorTemplate,
} from "../../connectors/template-resolver.ts";
import templateSkillsJson from "../../connectors/template-skills.json" with { type: "json" };
import { matchTemplatesByUrl, type TemplateUrlMatch } from "../../connectors/template-url-match.ts";
import {
  type ConnectorTemplate,
  ConnectorTemplateSchema,
  UnsupportedIngestionSourceError,
} from "../../connectors/templates.ts";
import type { ConnectorView, CreateConnectorInput } from "../../connectors/types.ts";
import { connectorTemplates } from "../../db/schema/index.ts";
import * as docsSvc from "../../docs-ingestion/service.ts";
import * as skillSvc from "../../skills/service.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ListResponseSchema = z
  .object({
    items: z.array(
      ConnectorTemplateSchema.safeExtend({
        source: z.enum(["builtin", "tenant"]),
        id: z.string().nullable(),
      }),
    ),
  })
  .openapi("ConnectorTemplateListResponse");

const CreateBodySchema = ConnectorTemplateSchema.openapi("ConnectorTemplateCreateBody");

const TemplateRowSchema = ConnectorTemplateSchema.safeExtend({
  id: z.string(),
  source: z.literal("tenant"),
}).openapi("ConnectorTemplateRow");

const ConnectorResponseSchema = z
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
    template_snapshot: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("ConnectorFromTemplateResponse");

const FromTemplateBody = z
  .object({
    name: z.string().min(1).optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    base_url_environment: z.string().optional(),
    ingest_now: z.boolean().optional(),
  })
  .openapi("ConnectorFromTemplateBody");

const MatchUrlQuery = z.object({
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

const MatchUrlResponseSchema = z
  .object({
    url: z.string(),
    matched: z.boolean(),
    matches: z.array(MatchUrlMatchSchema),
  })
  .openapi("ConnectorTemplateUrlMatchResponse");

const SlugParam = z.object({ slug: z.string().min(1) });
const TemplateSlugParam = z.object({ slug: z.string().min(1) });

const TemplateOAuthCredentialBody = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  })
  .openapi("TemplateOAuthCredentialBody");

const TemplateOAuthCredentialResponse = z
  .object({ id: z.string() })
  .openapi("TemplateOAuthCredentialResponse");

const listRoute = createRoute({
  method: "get",
  path: "/v1/connector-templates",
  tags: ["connectors"],
  summary: "List connector templates (built-ins + tenant overrides)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponseSchema } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/connector-templates",
  tags: ["connectors"],
  summary: "Add a tenant connector template override",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateBodySchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TemplateRowSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRouteSpec = createRoute({
  method: "delete",
  path: "/v1/connector-templates/{id}",
  tags: ["connectors"],
  summary: "Delete a tenant connector template override",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const ImportRequestSchema = z
  .object({
    source: z.enum(["postman", "har", "openapi", "graphql", "graphql_introspection", "curl"]),
    content: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1).optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    base_url_environment: z.string().optional(),
  })
  .openapi("ConnectorSpecImportRequest");

const ImportDraftSchema = z
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

const ImportResponseSchema = z
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

const importRoute = createRoute({
  method: "post",
  path: "/v1/connector-templates/import",
  tags: ["connectors"],
  summary: "Import a connector draft from a Postman/HAR/OpenAPI/GraphQL/curl spec",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: ImportRequestSchema } } } },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ImportResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    502: {
      description: "Upstream spec fetch failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const matchUrlRoute = createRoute({
  method: "get",
  path: "/v1/connector-templates/match-url",
  tags: ["connectors"],
  summary: "Match a URL to connector templates by url_pattern regex",
  security: [{ bearerAuth: [] }],
  request: { query: MatchUrlQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MatchUrlResponseSchema } },
    },
  },
});

const fromTemplateRoute = createRoute({
  method: "post",
  path: "/v1/connectors/from-template/{slug}",
  tags: ["connectors"],
  summary: "Instantiate a connector from a template",
  security: [{ bearerAuth: [] }],
  request: {
    params: SlugParam,
    body: { content: { "application/json": { schema: FromTemplateBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ConnectorResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const templateOauthCredentialRoute = createRoute({
  method: "post",
  path: "/v1/connector-templates/{slug}/oauth-credentials",
  tags: ["connectors"],
  summary: "Store tenant-scoped OAuth client credentials for a connector template",
  security: [{ bearerAuth: [] }],
  request: {
    params: TemplateSlugParam,
    body: { content: { "application/json": { schema: TemplateOAuthCredentialBody } } },
  },
  responses: {
    200: {
      description: "Stored",
      content: { "application/json": { schema: TemplateOAuthCredentialResponse } },
    },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function requireAdmin(p: import("../../auth/types.ts").ResolvedPrincipal): void {
  const decision = policy.adminOnly(p);
  if (!decision.allowed) throw new ForbiddenError(decision.reason ?? "admin_required");
}

function templateAuthToConnectorAuth(
  authType: ConnectorTemplate["auth_type"],
): CreateConnectorInput["auth_type"] {
  return authType;
}

function serializeResolvedTemplate(
  resolved: ResolvedConnectorTemplate,
): z.infer<typeof ListResponseSchema>["items"][number] {
  return {
    ...resolved.template,
    source: resolved.source,
    id: resolved.id,
    version: resolved.template.version,
  };
}

function serializeConnector(connector: ConnectorView): z.infer<typeof ConnectorResponseSchema> {
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

export function registerConnectorTemplateRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC gating. Templates are read under connector:read and created /
  // deleted under connector:write. The legacy `requireAdmin` helper still
  // runs so legacy tenant-admin-only behaviour is preserved, but the
  // RBAC middleware is the authoritative gate.
  app.use("/v1/connector-templates", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/:id", async (c, next) => {
    if (c.req.method === "DELETE") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/:slug/oauth-credentials", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connectors/from-template/:slug", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/match-url", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    return next();
  });
  app.use("/v1/connector-templates/import", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });

  app.openapi(importRoute, async (c) => {
    requireAuth(c);
    const body = c.req.valid("json");
    const tool = await import("../../conversations/tools/import-connector-from-spec.ts");
    try {
      const result = await tool.importConnectorFromSpecTool.execute(
        // The tool only uses args — context is unused for the import operation.
        {} as Parameters<typeof tool.importConnectorFromSpecTool.execute>[0],
        body,
      );
      if (!result.ok) {
        throw new BadRequestError(
          String((result.data as { error?: string } | null)?.error ?? "import failed"),
        );
      }
      const data = result.data as {
        draft: unknown;
        template_match: { slug: string; score: number; matched_segment: string } | null;
        recommended_next: string[];
      };
      return c.json(data as z.infer<typeof ImportResponseSchema>, 200);
    } catch (err) {
      const mod = await import("../../connectors/spec-fetchers.ts");
      if (err instanceof mod.SpecFetchError) {
        throw new BadRequestError(`spec fetch failed: ${err.message}`);
      }
      throw err;
    }
  });

  app.openapi(matchUrlRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { url, limit } = c.req.valid("query");
    const resolvedTemplates = await listResolvedConnectorTemplates(db, principal.tenant_id);
    // invariant: matchTemplatesByUrl only returns slugs from the same input
    // list, so every match has a corresponding resolved template — but we
    // skip silently if the cross-reference ever drifts instead of crashing.
    const matches: Array<TemplateUrlMatch & { resolved: ResolvedConnectorTemplate }> =
      matchTemplatesByUrl(
        url,
        limit,
        resolvedTemplates.map((entry) => entry.template),
      ).flatMap((entry) => {
        const resolved = resolvedTemplates.find(
          (candidate) => candidate.template.slug === entry.template.slug,
        );
        return resolved ? [{ ...entry, resolved }] : [];
      });
    return c.json(
      {
        url,
        matched: matches.length > 0,
        matches: matches.map(({ template, score, matched_segment, resolved }) => ({
          slug: template.slug,
          name: template.name,
          driver: template.driver,
          source: resolved.source,
          version: template.version,
          score,
          matched_segment,
          description: template.description,
          setup_instructions: template.setup_instructions,
          credential_hints: template.credential_hints,
          keywords: template.keywords,
          capabilities: template.capabilities,
        })),
      },
      200,
    );
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = (await listResolvedConnectorTemplates(db, principal.tenant_id)).map(
      serializeResolvedTemplate,
    );
    return c.json({ items }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const body = c.req.valid("json");
    const inserted = await db
      .insert(connectorTemplates)
      .values({
        tenant_id: principal.tenant_id,
        slug: body.slug,
        name: body.name,
        driver: body.driver,
        // base_url / url_pattern / ingestion_source are nullable in the
        // builtin-template Zod schema (per-tenant templates like AppSync
        // don't ship a fixed URL); the DB column is still non-null today,
        // so coalesce to empty string to keep tenant-template inserts
        // working until the DB migration relaxes the constraint.
        base_url: body.base_url ?? "",
        auth_type: body.auth_type,
        oauth: body.oauth ?? null,
        default_skill: body.default_skill ?? null,
        ingestion_source: body.ingestion_source ?? "unsupported",
        ingestion_url: body.ingestion_url ?? null,
        icon: body.icon,
        description: body.description,
        category: body.category,
        tags: body.tags ?? [],
        aliases: body.aliases ?? [],
        setup_instructions: body.setup_instructions,
        auth_options: body.auth_options ?? [],
        version: 1,
        url_pattern: body.url_pattern ?? "",
        keywords: body.keywords ?? [],
        inline_schema: body.inline_schema ?? null,
        probe_endpoint: body.probe_endpoint ?? null,
        credential_hints: body.credential_hints ?? [],
        base_url_options: body.base_url_options ?? [],
        pagination_defaults: body.pagination_defaults ?? null,
        capabilities: body.capabilities,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new BadRequestError("template insert failed");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.CONNECTOR_CREATED,
        resource_type: "connector_template",
        resource_id: row.id,
        result: "success",
        metadata: { slug: row.slug, source: "tenant_override" },
      },
      db,
    );
    const response: z.infer<typeof TemplateRowSchema> = {
      ...body,
      id: row.id,
      source: "tenant",
      version: 1,
    };
    return c.json(response, 201);
  });

  app.openapi(templateOauthCredentialRoute, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const { slug } = c.req.valid("param");
    const body = c.req.valid("json");
    const resolved = await resolveConnectorTemplate({
      db,
      tenant_id: principal.tenant_id,
      slug,
    });
    if (!resolved) throw new NotFoundError("connector_template");
    const row = await upsertTemplateOAuthCredentials(
      {
        tenant_id: principal.tenant_id,
        template_slug: slug,
        value: {
          client_id: body.client_id,
          client_secret: body.client_secret,
        },
        actor_id: principal.id,
      },
      db,
    );
    return c.json(row, 200);
  });

  app.openapi(deleteRouteSpec, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const existing = await db
      .select()
      .from(connectorTemplates)
      .where(
        and(eq(connectorTemplates.tenant_id, principal.tenant_id), eq(connectorTemplates.id, id)),
      )
      .limit(1);
    if (!existing[0]) throw new NotFoundError("connector_template");
    await db.delete(connectorTemplates).where(eq(connectorTemplates.id, id));
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.CONNECTOR_DELETED,
        resource_type: "connector_template",
        resource_id: id,
        result: "success",
        metadata: { slug: existing[0].slug },
      },
      db,
    );
    return c.body(null, 204);
  });

  app.openapi(fromTemplateRoute, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const { slug } = c.req.valid("param");
    const body = c.req.valid("json");

    const resolved = await resolveConnectorTemplate({
      db,
      tenant_id: principal.tenant_id,
      slug,
    });
    if (!resolved) throw new NotFoundError("connector_template");
    const template = resolved.template;

    if (body.ingest_now && template.ingestion_source === "unsupported") {
      throw new UnsupportedIngestionSourceError(template.slug);
    }
    const created = await connectorSvc.createConnector(
      {
        tenant_id: principal.tenant_id,
        input: {
          name: body.name ?? template.name,
          slug: template.slug,
          driver: template.driver,
          environment: body.environment ?? "dev",
          auth_type: templateAuthToConnectorAuth(template.auth_type),
          template_slug: template.slug,
          template_source: resolved.source,
          ...(body.base_url_environment
            ? { template_base_url_environment: body.base_url_environment }
            : {}),
        },
        actor_id: principal.id,
      },
      db,
    );
    const shouldIngest =
      body.ingest_now ?? (template.inline_schema !== null || template.ingestion_url !== null);
    if (shouldIngest) {
      await docsSvc.ingestTemplateDocsForConnector(
        {
          tenant_id: principal.tenant_id,
          connector_id: created.id,
          template,
          actor_id: principal.id,
        },
        db,
      );
    }

    // Seed the default skill for this connector from template-skills.json.
    if (template.default_skill) {
      const skillDef = (templateSkillsJson as Record<string, unknown>)[template.default_skill] as
        | {
            title: string;
            body: string;
            examples?: string[];
            best_practices?: string[];
            pitfalls?: string[];
            doc_refs?: string[];
          }
        | undefined;
      if (skillDef) {
        try {
          await skillSvc.createSkill(
            {
              tenant_id: principal.tenant_id,
              input: {
                scope: "connector",
                connector_id: created.id,
                title: skillDef.title,
                body: skillDef.body,
                examples: skillDef.examples,
                best_practices: skillDef.best_practices,
                pitfalls: skillDef.pitfalls,
                doc_refs: skillDef.doc_refs,
              },
              actor_id: principal.id,
            },
            db,
          );
        } catch {
          // Skill seeding is best-effort — don't fail connector creation.
        }
      }
    }

    // Add a second audit row that captures the template_slug provenance.
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.CONNECTOR_CREATED,
        resource_type: "connector",
        resource_id: created.id,
        result: "success",
        metadata: {
          template_slug: template.slug,
          ingestion_source: template.ingestion_source,
          source: resolved.source === "tenant" ? "tenant_template" : "builtin_template",
        },
      },
      db,
    );

    return c.json(serializeConnector(created), 201);
  });
}
