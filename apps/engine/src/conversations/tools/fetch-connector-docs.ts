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
  description: "Search the scoped connector docs and return the top chunks.",
  inputSchema,
  category: "tenant_read" as const,
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
