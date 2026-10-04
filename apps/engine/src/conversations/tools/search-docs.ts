import { z } from "@hono/zod-openapi";
import { searchDocs } from "../../docs-ingestion/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    query: z.string().min(1),
    connector_id: z.string().uuid().optional(),
    limit: z.number().int().positive().max(20).optional(),
  })
  .openapi("SearchDocsToolInput");

export const searchDocsTool: ConversationTool = {
  name: "search_docs",
  description:
    "Search a connector's ingested documentation (OpenAPI / GraphQL / HTML / Markdown chunks) for ranked endpoint, auth, or schema context. Use when the authoring loop needs more detail than the pre-assembled docs block carries.",
  inputSchema,
  category: "tenant_read" as const,
  use_case:
    "Pull endpoint- or field-level detail for a specific connector while drafting a step. Complements `fetch_connector_docs` (which returns a connector overview) and `search_knowledge` (which searches tenant Knowledge Sources).",
  important_notes: [
    "Requires a connector scope — pass `connector_id` when the conversation is not already bound to a connector.",
    "Results are ranked snippets, not full documents. Inspect `match_type` to see whether the hit is operation-, auth-, or schema-oriented.",
    "For the full text, open the chunk id via `fetch_connector_docs`.",
  ],
  example_input: {
    query: "create customer",
    limit: 5,
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connector_id = args.connector_id ?? ctx.connector_id;
    if (!connector_id) {
      return {
        ok: false,
        data: {
          error:
            "connector_id is required — pass it explicitly or bind the conversation to a connector first",
        },
      };
    }
    const hits = await searchDocs(
      {
        tenant_id: ctx.tenant_id,
        connector_id,
        query: args.query,
        limit: args.limit ?? 5,
      },
      ctx.db,
    );
    return {
      ok: true,
      data: { hits },
    };
  },
};
