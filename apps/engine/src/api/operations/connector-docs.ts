import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { getConnector } from "../../connectors/service.ts";
import { PageTooLargeError } from "../../docs-ingestion/budgets.ts";
import {
  deleteDoc,
  type IngestParams,
  ingestDocs,
  listDocs,
  type SearchParams,
  searchDocs,
} from "../../docs-ingestion/service.ts";
import { DocumentSourceCredentialsError, NotImplementedError } from "../../docs-ingestion/types.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const DocIdParam = z.object({ id: z.string().uuid(), document_id: z.string().uuid() });

const IngestBody = z
  .object({
    source_type: z.enum(["openapi", "google_discovery", "markdown", "llms_txt"]),
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

type IngestInput = { readonly id: string } & z.infer<typeof IngestBody>;
type SearchInput = { readonly id: string } & z.infer<typeof SearchQuery>;
type DeleteInput = z.infer<typeof DocIdParam>;

async function connectorMissing(scope: OperationScope, id: string): Promise<Rejection | null> {
  const connector = await getConnector(scope.tenant_id, id, scope.db);
  return connector ? null : reject.notFound("connector");
}

export const ingestConnectorDocsOperation = defineOperation<
  IngestInput,
  Awaited<ReturnType<typeof ingestDocs>>
>({
  id: "connector.docs.ingest",
  summary: "Ingest documentation into a connector",
  permission: "connector:write",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_DOCS_INGESTED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const missing = await connectorMissing(scope, input.id);
    if (missing) return missing;
    if (!input.url && !input.content) return reject.badRequest("either url or content is required");
    try {
      const source: IngestParams["input"] = { source_type: input.source_type };
      if (input.url !== undefined) source.url = input.url;
      if (input.content !== undefined) source.content = input.content;
      return await ingestDocs(
        {
          tenant_id: scope.tenant_id,
          connector_id: input.id,
          input: source,
          actor_id: principal.id,
          actor: actorOf(principal),
        },
        scope.db,
      );
    } catch (err) {
      if (err instanceof NotImplementedError || err instanceof DocumentSourceCredentialsError) {
        return reject.badRequest(err.message);
      }
      if (err instanceof PageTooLargeError)
        return reject.badRequest(err.message, { bytes: err.bytes });
      throw err;
    }
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/docs/ingest",
    tags: ["connectors"],
    params: IdParam,
    body: IngestBody,
    response: IngestResponse,
    errors: { 400: "Bad request", 404: "Not found" },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      ...(json as z.infer<typeof IngestBody>),
    }),
    toBody: (result) => result,
  },
});

export const listConnectorDocsOperation = defineOperation<
  { readonly id: string },
  { items: Awaited<ReturnType<typeof listDocs>> }
>({
  id: "connector.docs.list",
  summary: "List ingested documentation sources",
  permission: "connector:read",
  resource: { type: "connector", param: "id" },
  effect: "read",
  async handler(scope, input) {
    const missing = await connectorMissing(scope, input.id);
    if (missing) return missing;
    return {
      items: await listDocs({ tenant_id: scope.tenant_id, connector_id: input.id }, scope.db),
    };
  },
  http: {
    method: "get",
    path: "/v1/connectors/{id}/docs",
    tags: ["connectors"],
    params: IdParam,
    response: ListResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (result) => result,
  },
});

export const searchConnectorDocsOperation = defineOperation<
  SearchInput,
  { items: Awaited<ReturnType<typeof searchDocs>> }
>({
  id: "connector.docs.search",
  summary: "Ranked search over ingested documentation",
  permission: "connector:read",
  resource: { type: "connector", param: "id" },
  effect: "read",
  async handler(scope, input) {
    const missing = await connectorMissing(scope, input.id);
    if (missing) return missing;
    const params: SearchParams = {
      tenant_id: scope.tenant_id,
      connector_id: input.id,
      query: input.q,
    };
    if (input.limit !== undefined) params.limit = input.limit;
    return { items: await searchDocs(params, scope.db) };
  },
  http: {
    method: "get",
    path: "/v1/connectors/{id}/docs/search",
    tags: ["connectors"],
    params: IdParam,
    query: SearchQuery,
    response: SearchResponse,
    errors: { 404: "Not found" },
    toInput: ({ param, query }) => ({
      id: (param as { id: string }).id,
      ...(query as z.infer<typeof SearchQuery>),
    }),
    toBody: (result) => result,
  },
});

export const deleteConnectorDocOperation = defineOperation<DeleteInput, true>({
  id: "connector.docs.delete",
  summary: "Delete an ingested documentation source",
  permission: "connector:write",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_DOCS_CLEARED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const missing = await connectorMissing(scope, input.id);
    if (missing) return missing;
    const deleted = await deleteDoc(
      {
        tenant_id: scope.tenant_id,
        connector_id: input.id,
        document_id: input.document_id,
        actor_id: principal.id,
        actor: actorOf(principal),
      },
      scope.db,
    );
    return deleted ? true : reject.notFound("connector_document");
  },
  http: {
    method: "delete",
    path: "/v1/connectors/{id}/docs/{document_id}",
    tags: ["connectors"],
    params: DocIdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => param as DeleteInput,
    toBody: () => null,
  },
});
