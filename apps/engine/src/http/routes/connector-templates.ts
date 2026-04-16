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
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { policy } from "../../auth/policy.ts";
import * as connectorSvc from "../../connectors/service.ts";
import templateSkillsJson from "../../connectors/template-skills.json" with { type: "json" };
import {
  type ConnectorTemplate,
  ConnectorTemplateSchema,
  loadBuiltinTemplates,
  UnsupportedIngestionSourceError,
} from "../../connectors/templates.ts";
import type { CreateConnectorInput } from "../../connectors/types.ts";
import { connectorTemplates } from "../../db/schema/index.ts";
import * as skillSvc from "../../skills/service.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { ErrorSchema } from "./identity/schemas.ts";

const ListResponseSchema = z
  .object({
    items: z.array(
      ConnectorTemplateSchema.extend({
        source: z.enum(["builtin", "tenant"]),
        id: z.string().nullable(),
      }),
    ),
  })
  .openapi("ConnectorTemplateListResponse");

const CreateBodySchema = ConnectorTemplateSchema.openapi("ConnectorTemplateCreateBody");

const TemplateRowSchema = ConnectorTemplateSchema.extend({
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
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("ConnectorFromTemplateResponse");

const FromTemplateBody = z
  .object({
    name: z.string().min(1).optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    ingest_now: z.boolean().optional(),
  })
  .openapi("ConnectorFromTemplateBody");

const SlugParam = z.object({ slug: z.string().min(1) });
const IdParam = z.object({ id: z.string().uuid() });

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

function requireAdmin(p: import("../../auth/types.ts").ResolvedPrincipal): void {
  const decision = policy.adminOnly(p);
  if (!decision.allowed) throw new ForbiddenError(decision.reason ?? "admin_required");
}

function templateAuthToConnectorAuth(
  authType: ConnectorTemplate["auth_type"],
): CreateConnectorInput["auth_type"] {
  return authType;
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
  app.use("/v1/connectors/from-template/:slug", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const builtins = loadBuiltinTemplates();
    const overrides = await db
      .select()
      .from(connectorTemplates)
      .where(eq(connectorTemplates.tenant_id, principal.tenant_id));
    const overrideMap = new Map<string, (typeof overrides)[number]>();
    for (const row of overrides) overrideMap.set(row.slug, row);

    const items: Array<z.infer<typeof ListResponseSchema>["items"][number]> = [];
    for (const t of builtins) {
      const override = overrideMap.get(t.slug);
      if (override) continue; // tenant row wins
      items.push({ ...t, source: "builtin", id: null });
    }
    for (const row of overrides) {
      items.push({
        slug: row.slug,
        name: row.name,
        driver: row.driver as ConnectorTemplate["driver"],
        base_url: row.base_url,
        auth_type: row.auth_type as ConnectorTemplate["auth_type"],
        oauth: (row.oauth as ConnectorTemplate["oauth"]) ?? null,
        default_skill: row.default_skill ?? null,
        ingestion_source: row.ingestion_source as ConnectorTemplate["ingestion_source"],
        ingestion_url: row.ingestion_url ?? null,
        icon: row.icon,
        description: row.description,
        category: (row as Record<string, unknown>).category as string | undefined,
        tags: ((row as Record<string, unknown>).tags as string[]) ?? [],
        setup_hint: ((row as Record<string, unknown>).setup_hint as string) ?? null,
        auth_options:
          ((row as Record<string, unknown>).auth_options as ConnectorTemplate["auth_options"]) ??
          [],
        source: "tenant",
        id: row.id,
      });
    }
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
        base_url: body.base_url,
        auth_type: body.auth_type,
        oauth: body.oauth ?? null,
        default_skill: body.default_skill ?? null,
        ingestion_source: body.ingestion_source,
        ingestion_url: body.ingestion_url ?? null,
        icon: body.icon,
        description: body.description,
        category: body.category ?? null,
        tags: body.tags ?? [],
        setup_hint: body.setup_hint ?? null,
        auth_options: body.auth_options ?? [],
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
    return c.json({ ...body, id: row.id, source: "tenant" as const }, 201);
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

    // Look at tenant overrides first, then built-ins.
    const overrideRows = await db
      .select()
      .from(connectorTemplates)
      .where(
        and(
          eq(connectorTemplates.tenant_id, principal.tenant_id),
          eq(connectorTemplates.slug, slug),
        ),
      )
      .limit(1);

    let template: ConnectorTemplate | null = null;
    if (overrideRows[0]) {
      const row = overrideRows[0];
      template = {
        slug: row.slug,
        name: row.name,
        driver: row.driver as ConnectorTemplate["driver"],
        base_url: row.base_url,
        auth_type: row.auth_type as ConnectorTemplate["auth_type"],
        oauth: (row.oauth as ConnectorTemplate["oauth"]) ?? null,
        default_skill: row.default_skill ?? null,
        ingestion_source: row.ingestion_source as ConnectorTemplate["ingestion_source"],
        ingestion_url: row.ingestion_url ?? null,
        icon: row.icon,
        description: row.description,
        category: (row as Record<string, unknown>).category as string | undefined,
        tags: ((row as Record<string, unknown>).tags as string[]) ?? [],
        setup_hint: ((row as Record<string, unknown>).setup_hint as string) ?? null,
        auth_options:
          ((row as Record<string, unknown>).auth_options as ConnectorTemplate["auth_options"]) ??
          [],
      };
    } else {
      template = loadBuiltinTemplates().find((t) => t.slug === slug) ?? null;
    }
    if (!template) throw new NotFoundError("connector_template");

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
          base_url: template.base_url,
          auth_type: templateAuthToConnectorAuth(template.auth_type),
          config: template.oauth ? { ...template.oauth } : {},
        },
        actor_id: principal.id,
      },
      db,
    );

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
          source: overrideRows[0] ? "tenant_template" : "builtin_template",
        },
      },
      db,
    );

    return c.json(
      {
        id: created.id,
        tenant_id: created.tenant_id,
        slug: created.slug,
        display_name: created.display_name,
        driver: created.driver,
        environment: created.environment,
        auth_type: created.auth_type,
        base_url: created.base_url,
        dsn: created.dsn,
        config: created.config,
        created_at: created.created_at.toISOString(),
        updated_at: created.updated_at.toISOString(),
      },
      201,
    );
  });
}
