import { createRoute, type OpenAPIHono, type z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import {
  createTenantConnectorTemplate,
  deleteTenantConnectorTemplate,
  listResolvedConnectorTemplates,
} from "../../../connectors/index.ts";
import { NotFoundError } from "../../errors.ts";
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
    const row = await createTenantConnectorTemplate(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        input: {
          slug: body.slug,
          name: body.name,
          driver: body.driver,
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
          url_pattern: body.url_pattern ?? "",
          keywords: body.keywords ?? [],
          inline_schema: body.inline_schema ?? null,
          probe_endpoint: body.probe_endpoint ?? null,
          credential_hints: body.credential_hints ?? [],
          base_url_options: body.base_url_options ?? [],
          pagination_defaults: body.pagination_defaults ?? null,
          capabilities: body.capabilities,
        },
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
    const deleted = await deleteTenantConnectorTemplate(
      { tenant_id: principal.tenant_id, actor_type: principal.kind, actor_id: principal.id, id },
      db,
    );
    if (!deleted) throw new NotFoundError("connector_template");
    return c.body(null, 204);
  });
}
