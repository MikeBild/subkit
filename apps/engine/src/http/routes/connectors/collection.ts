import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { compareCategoryCounts } from "../../../api/catalog-metadata.ts";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { actorOf } from "../../../audit/actor.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import {
  CreateConnectorSchema,
  runDiscoveryCached,
  UpdateConnectorSchema,
} from "../../../connectors/index.ts";
import * as credsvc from "../../../credentials/index.ts";
import { logger } from "../../../logging/index.ts";

import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { ConnectorListResponse, ConnectorSchema, serialize } from "./schemas.ts";

async function warmGraphqlSchema(
  db: AppEnv["Variables"]["db"],
  tenant_id: string,
  actor_type: "user" | "system_account",
  actor_id: string | null,
  connector: { id: string; driver: string; base_url: string | null },
): Promise<void> {
  if (connector.driver !== "graphql" || !connector.base_url) return;
  try {
    await runDiscoveryCached(
      { db, tenant_id, actor_type, actor_id, abortSignal: AbortSignal.timeout(6_000) },
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
        kind: z
          .enum(["oauth", "mcp", "key"])
          .optional()
          .describe(
            "MCP takes precedence over authentication kind. OAuth selects non-MCP OAuth connectors; key selects non-MCP header, query, bearer, basic or AWS signature authentication. Unauthenticated connectors remain in the unfiltered list.",
          ),
        enabled: z
          .enum(["true", "false"])
          .transform((value) => value === "true")
          .optional(),
        health_state: z
          .enum(["ok", "degraded", "needs_reauth", "needs_update", "needs_attention"])
          .optional(),
        health: z
          .enum(["not_ok"])
          .optional()
          .describe(
            "`not_ok`: only the connectors that count against the connector-health ratio of the operational overview — enabled and any health state but `ok`. `total` and paging apply to the narrowed list; combined with `enabled=false` the list is empty.",
          ),
        q: z.string().min(1).max(200).optional(),
        sort: z.enum(["name", "driver", "environment", "enabled", "updated_at"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        limit: z.coerce.number().int().positive().max(1000).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        description_source: z.enum(["llm", "human"]).optional(),
        category: z
          .string()
          .optional()
          .describe(
            "Only connectors in this catalog block (see the `category` field on each item)",
          ),
        driver: z
          .string()
          .optional()
          .describe("Only connectors of this driver (http, graphql, postgres, s3, mcp, …)"),
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
    400: {
      description: "Invalid description acceptance",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "The reviewed description changed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    200: { description: "OK", content: { "application/json": { schema: ConnectorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function enablementRoute(segment: "enable" | "disable") {
  return createRoute({
    method: "post",
    path: `/v1/connectors/{id}/${segment}`,
    tags: ["connectors"],
    summary: `${segment === "enable" ? "Enable" : "Disable"} a connector`,
    security: [{ bearerAuth: [] }],
    request: { params: IdParam },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: ConnectorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
}

const enableRoute = enablementRoute("enable");
const disableRoute = enablementRoute("disable");

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
    if (q.description_source) opts.description_source = q.description_source;
    if (q.driver) opts.driver = q.driver;
    if (q.kind) opts.kind = q.kind;
    if (q.enabled !== undefined) opts.enabled = q.enabled;
    if (q.health_state) opts.health_state = q.health_state;
    if (q.health) opts.health = q.health;
    if (q.q) opts.q = q.q;
    if (q.sort) opts.sort = q.sort;
    if (q.order) opts.order = q.order;
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.offset !== undefined) opts.offset = q.offset;
    const { rows, total } = await connectorSvc.listConnectors(principal.tenant_id, opts, db);
    const observations = await connectorSvc.connectorObservations(
      db,
      principal.tenant_id,
      rows.map((row) => row.id),
    );
    const items = rows.map((r) => ({ ...serialize(r), ...observations.get(r.id) }));
    const counts = await connectorSvc.connectorCategoryCounts(principal.tenant_id, db);
    const blocks = [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort(compareCategoryCounts);
    return c.json({ items, total, categories: blocks }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const created = await connectorSvc.createConnector(
      {
        tenant_id: principal.tenant_id,
        input: body,
        actor_id: principal.id,
        actor: actorOf(principal),
      },
      db,
    );
    await warmGraphqlSchema(db, principal.tenant_id, principal.kind, principal.id, created);
    return c.json(serialize(created), 201);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const found = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!found) throw new NotFoundError("connector");
    const rows = await connectorSvc.listConnectorCredentials(principal.tenant_id, id, db);
    const connections = await credsvc.summarizeConnections(
      db,
      principal.tenant_id,
      rows.flatMap((row) => (row.connection_id ? [row.connection_id] : [])),
    );
    const creds = rows.map(({ connection_id, ...row }) => ({
      ...row,
      connection: connection_id ? (connections.get(connection_id) ?? null) : null,
    }));
    const observations = await connectorSvc.connectorObservations(db, principal.tenant_id, [
      found.id,
    ]);
    return c.json({ ...serialize(found), ...observations.get(found.id), credentials: creds }, 200);
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
      actorOf(principal),
      db,
    );
    if (!updated) throw new NotFoundError("connector");
    return c.json(serialize(updated), 200);
  });

  for (const [route, enabled] of [
    [enableRoute, true],
    [disableRoute, false],
  ] as const) {
    app.openapi(route, async (c) => {
      const principal = requireAuth(c);
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const updated = await connectorSvc.setConnectorEnabled(
        principal.tenant_id,
        id,
        enabled,
        actorOf(principal),
        db,
      );
      if (!updated) throw new NotFoundError("connector");
      return c.json(serialize(updated), 200);
    });
  }

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await connectorSvc.deleteConnector(principal.tenant_id, id, actorOf(principal), db);
    if (!ok) throw new NotFoundError("connector");
    return c.body(null, 204);
  });
}
