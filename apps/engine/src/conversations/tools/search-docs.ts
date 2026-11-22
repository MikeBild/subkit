import { z } from "@hono/zod-openapi";
import { searchDocs } from "../../docs-ingestion/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { searchProductDocs } from "./product-docs.ts";

const inputSchema = z
  .object({
    query: z.string().min(1),
    connector_id: z.string().uuid().optional(),
    source: z.enum(["product", "connector"]).optional(),
    locale: z.enum(["en", "de"]).optional(),
    limit: z.number().int().positive().max(20).optional(),
  })
  .openapi("SearchDocsToolInput");

export const searchDocsTool: ConversationTool = {
  name: "search_docs",
  description:
    "Search the SubKit product documentation shipped with this engine, or a connector's ingested documentation (OpenAPI / GraphQL / HTML / Markdown chunks) for ranked endpoint, auth, or schema context.",
  inputSchema,
  category: "tenant_read" as const,
  use_case:
    "Answer questions about SubKit itself (install, subkit CLI, Cockpit, Web Clipper, settings) from the product documentation, or pull endpoint- or field-level detail for a specific connector while drafting a step. Complements `fetch_connector_docs` (which returns a connector overview) and `search_knowledge` (which searches tenant Knowledge Sources).",
  important_notes: [
    "Source `product` searches the read-only product documentation in English and German; each hit names its chapter `slug`, `heading`, `anchor` and content `sha256`. It is the default when no connector is bound.",
    "Source `connector` searches a connector's ingested docs and requires `connector_id` unless the conversation is bound to a connector; it is the default when a connector is bound.",
    "Results are ranked snippets, not full documents. For connector hits, inspect `match_type` to see whether the hit is operation-, auth-, or schema-oriented.",
    "For the full text of a connector hit, open the chunk id via `fetch_connector_docs`.",
  ],
  example_input: {
    query: "create customer",
    limit: 5,
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connector_id = args.connector_id ?? ctx.connector_id;
    const source = args.source ?? (connector_id ? "connector" : "product");
    if (source === "product") {
      return {
        ok: true,
        data: {
          hits: searchProductDocs({
            query: args.query,
            limit: args.limit ?? 5,
            ...(args.locale ? { locale: args.locale } : {}),
          }),
        },
      };
    }
    if (!connector_id) {
      const message =
        "connector_id is required — pass it explicitly or bind the conversation to a connector first";
      return {
        ok: false,
        data: {
          error: message,
          error_code: "connector_scope_required",
          message,
          next_best_actions: ["find_connector", "list_connectors"],
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
