// Collection-level + per-resource CRUD on connectors:
//   GET    /v1/connectors
//   POST   /v1/connectors
//   GET    /v1/connectors/{id}
//   PATCH  /v1/connectors/{id}
//   DELETE /v1/connectors/{id}

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import { CreateConnectorSchema, UpdateConnectorSchema } from "../../../connectors/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { ConnectorListResponse, ConnectorSchema, serialize } from "./schemas.ts";

const listRoute = createRoute({
  method: "get",
  path: "/v1/connectors",
  tags: ["connectors"],
  summary: "List connectors",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({ environment: z.enum(["dev", "prod"]).optional() })
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
    const { rows, total } = await connectorSvc.listConnectors(principal.tenant_id, opts, db);
    return c.json({ items: rows.map(serialize), total }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const created = await connectorSvc.createConnector(
      { tenant_id: principal.tenant_id, input: body, actor_id: principal.id },
      db,
    );
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
