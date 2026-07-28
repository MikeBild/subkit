// Collection-level + per-resource CRUD on connectors:
//   GET    /v1/connectors
//   POST   /v1/connectors
//   GET    /v1/connectors/{id}
//   PATCH  /v1/connectors/{id}
//   DELETE /v1/connectors/{id}

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import {
  CreateConnectorSchema,
  runDiscoveryCached,
  UpdateConnectorSchema,
} from "../../../connectors/index.ts";
import { logger } from "../../../logging/index.ts";
import { groupByCategory } from "../../../workflows/index.ts";

import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { ConnectorListResponse, ConnectorSchema, serialize } from "./schemas.ts";

/** OPT-D: warm a GraphQL connector's schema at creation. A GraphQL API is
 *  introspectable, so the moment a connector is created we run `__schema`
 *  introspection and ingest the SDL as searchable knowledge (and record its
 *  self-description LINK) — the authoring agent then has the relay/enum/filter
 *  shapes in context WITHOUT a discover_connector_endpoints round-trip. Bounded +
 *  non-fatal. HTTP connectors are deliberately NOT warmed here: their
 *  self-description LINKS are captured lazily on the first
 *  `discover_connector_endpoints` call (which forwards connector_id) and enriched
 *  by the self-healing scheduler pass — no synchronous network cost on create. */
async function warmGraphqlSchema(
  db: AppEnv["Variables"]["db"],
  tenant_id: string,
  actor_id: string | null,
  connector: { id: string; driver: string; base_url: string | null },
): Promise<void> {
  if (connector.driver !== "graphql" || !connector.base_url) return;
  try {
    await runDiscoveryCached(
      { db, tenant_id, actor_id, abortSignal: AbortSignal.timeout(6_000) },
      { base_url: connector.base_url, connector_id: connector.id },
    );
  } catch (err) {
    logger.warn({
      module: "connectors",
      action: "graphql_schema_warm.failed",
      connector_id: connector.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/connectors",
  tags: ["connectors"],
  summary: "List connectors",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        environment: z.enum(["dev", "prod"]).optional(),
        category: z
          .string()
          .optional()
          .describe(
            "Only connectors in this catalog block (see the `category` field on each item)",
          ),
      })
      .openapi("ListConnectorsQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ConnectorListResponse } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/connectors",
  tags: ["connectors"],
  summary: "Create a connector",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateConnectorSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ConnectorSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}",
  tags: ["connectors"],
  summary: "Fetch a connector",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ConnectorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/v1/connectors/{id}",
  tags: ["connectors"],
  summary: "Update a connector",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateConnectorSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ConnectorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/connectors/{id}",
  tags: ["connectors"],
  summary: "Delete a connector",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerCollectionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const opts: Parameters<typeof connectorSvc.listConnectors>[1] = {};
    if (q.environment) opts.environment = q.environment;
    if (q.category) opts.category = q.category;
    const { rows, total } = await connectorSvc.listConnectors(principal.tenant_id, opts, db);
    const items = rows.map((r) => ({
      ...serialize(r),
      category: connectorSvc.categoryOfConnector(r),
    }));
    const blocks = groupByCategory(items, (i) => i.category).map((b) => ({
      category: b.category,
      count: b.items.length,
    }));
    return c.json({ items, total, categories: blocks }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const created = await connectorSvc.createConnector(
      { tenant_id: principal.tenant_id, input: body, actor_id: principal.id },
      db,
    );
    // OPT-D: introspect + ingest the schema for a GraphQL connector so the SDL
    // is searchable knowledge before any authoring. Bounded + non-fatal.
    await warmGraphqlSchema(db, principal.tenant_id, principal.id, created);
    return c.json(serialize(created), 201);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const found = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!found) throw new NotFoundError("connector");
    // Embed redacted credential summaries so `sk credentials list` (and any GET
    // consumer) can see what's attached — no secret material is included.
    const creds = await connectorSvc.listConnectorCredentials(principal.tenant_id, id, db);
    return c.json({ ...serialize(found), credentials: creds }, 200);
  });

  app.openapi(patchRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await connectorSvc.updateConnector(
      principal.tenant_id,
      id,
      body,
      principal.id,
      db,
    );
    if (!updated) throw new NotFoundError("connector");
    return c.json(serialize(updated), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await connectorSvc.deleteConnector(principal.tenant_id, id, principal.id, db);
    if (!ok) throw new NotFoundError("connector");
    return c.body(null, 204);
  });
}
