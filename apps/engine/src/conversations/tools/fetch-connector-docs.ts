// fetch_connector_docs — thin wrapper over the P6 tsvector search.

import { z } from "@hono/zod-openapi";

import { searchDocs } from "../../docs-ingestion/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(20).optional(),
  })
  .openapi("FetchConnectorDocsToolInput");

export const fetchConnectorDocsTool: ConversationTool = {
  name: "fetch_connector_docs",
  description:
    "Search the ingested connector docs (OpenAPI specs, API references, vendor notes) for the connector currently in scope. Call this before drafting a `request` step or answering vendor-API questions — endpoints, required headers, auth shapes, pagination tokens should come from docs, not guesses. Use a short focused query matching the endpoint or concept you need. Requires a connector in scope; returns `no connector in scope` otherwise.",
  inputSchema,
  category: "tenant_read" as const,
  // Builds a definition rather than using one: withheld from the
  // read-and-execute tier even though it only reads.
  authoring_only: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    if (!ctx.connector_id) {
      return {
        ok: false,
        data: { error: "no connector in scope" },
      };
    }
    const hits = await searchDocs(
      {
        tenant_id: ctx.tenant_id,
        connector_id: ctx.connector_id,
        query: args.query,
        limit: args.limit ?? 5,
      },
      ctx.db,
    );
    return {
      ok: true,
      data: { hits: hits.slice(0, 5) },
    };
  },
};
