// Collection-level connector-template endpoints:
//   GET    /v1/connector-templates                — list built-ins + tenant overrides
//   POST   /v1/connector-templates                — admin: add a tenant override
//   DELETE /v1/connector-templates/{id}           — admin: remove a tenant override

import { createRoute, type OpenAPIHono, type z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { listResolvedConnectorTemplates } from "../../../connectors/template-resolver.ts";
import { connectorTemplates } from "../../../db/schema/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  CreateBodySchema,
  ListResponseSchema,
  requireAdmin,
  serializeResolvedTemplate,
  TemplateRowSchema,
} from "./schemas.ts";

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

export function registerCollectionRoutes(app: OpenAPIHono<AppEnv>): void {
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
}
