// HTTP surface for connector documentation ingestion + search.
//
//   POST   /v1/connectors/:id/docs/ingest          — run the pipeline now
//   GET    /v1/connectors/:id/docs                  — list ingested sources
//   GET    /v1/connectors/:id/docs/search           — tsvector search
//   DELETE /v1/connectors/:id/docs/:document_id     — remove a source + chunks
//
// The route layer is thin: permission check, resolve connector, hand off
// to the service. Request errors bubble through the shared error
// middleware.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import * as connectorSvc from "../../connectors/service.ts";
import { PageTooLargeError } from "../../docs-ingestion/budgets.ts";
import * as docs from "../../docs-ingestion/service.ts";
import { NotImplementedError } from "../../docs-ingestion/types.ts";
import { BadRequestError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const DocIdParam = z.object({ id: z.string().uuid(), document_id: z.string().uuid() });

const IngestBody = z
  .object({
    source_type: z.enum(["openapi", "markdown", "llms_txt"]),
    url: z.string().url().optional(),
    content: z.string().optional(),
  })
  .openapi("ConnectorDocsIngestBody");

const IngestResponse = z
  .object({
    document_id: z.string().nullable(),
    ingested_count: z.number(),
    skipped_count: z.number(),
    total_bytes: z.number(),
    budget_exceeded: z.boolean(),
    source_type: z.string(),
    source_uri: z.string(),
  })
  .openapi("ConnectorDocsIngestResponse");

const ListResponse = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        source_type: z.string(),
        source_uri: z.string(),
        version: z.string(),
        bytes_total: z.number(),
        chunk_count: z.number(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
  })
  .openapi("ConnectorDocsListResponse");

const SearchQuery = z
  .object({
    q: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .openapi("ConnectorDocsSearchQuery");

const SearchResponse = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        document_id: z.string(),
        title: z.string().nullable(),
        path: z.string().nullable(),
        snippet: z.string(),
        rank: z.number(),
        match_type: z.enum(["operation", "auth", "schema", "general"]),
        fetched_at: z.string().nullable(),
      }),
    ),
  })
  .openapi("ConnectorDocsSearchResponse");

const ingestRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/docs/ingest",
  tags: ["connectors"],
  summary: "Ingest documentation into a connector",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: IngestBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: IngestResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/docs",
  tags: ["connectors"],
  summary: "List ingested documentation sources",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const searchRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/docs/search",
  tags: ["connectors"],
  summary: "Ranked search over ingested documentation",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam, query: SearchQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SearchResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/connectors/{id}/docs/{document_id}",
  tags: ["connectors"],
  summary: "Delete an ingested documentation source",
  security: [{ bearerAuth: [] }],
  request: { params: DocIdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerConnectorDocsRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC gating: ingest/delete = connector:write, list/search = connector:read.
  // The resource type is the parent connector so resource grants keyed
  // off the connector row apply naturally.
  app.use("/v1/connectors/:id/docs", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("connector:read", () => ({ type: "connector", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/connectors/:id/docs/ingest", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:write", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/docs/search", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:read", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/docs/:document_id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "DELETE") {
      return requirePermission("connector:write", () => ({ type: "connector", id }))(c, next);
    }
    return next();
  });

  app.openapi(ingestRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    if (!body.url && !body.content) {
      throw new BadRequestError("either url or content is required");
    }
    try {
      const input: docs.IngestParams["input"] = { source_type: body.source_type };
      if (body.url !== undefined) input.url = body.url;
      if (body.content !== undefined) input.content = body.content;
      const result = await docs.ingestDocs(
        {
          tenant_id: principal.tenant_id,
          connector_id: id,
          input,
          actor_id: principal.id,
        },
        db,
      );
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof NotImplementedError) {
        throw new BadRequestError(err.message);
      }
      if (err instanceof PageTooLargeError) {
        throw new BadRequestError(err.message, { bytes: err.bytes });
      }
      throw err;
    }
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const items = await docs.listDocs({ tenant_id: principal.tenant_id, connector_id: id }, db);
    return c.json({ items }, 200);
  });

  app.openapi(searchRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const searchParams: docs.SearchParams = {
      tenant_id: principal.tenant_id,
      connector_id: id,
      query: q.q,
    };
    if (q.limit !== undefined) searchParams.limit = q.limit;
    const items = await docs.searchDocs(searchParams, db);
    return c.json({ items }, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, document_id } = c.req.valid("param");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const ok = await docs.deleteDoc(
      {
        tenant_id: principal.tenant_id,
        connector_id: id,
        document_id,
        actor_id: principal.id,
      },
      db,
    );
    if (!ok) throw new NotFoundError("connector_document");
    return c.body(null, 204);
  });
}
