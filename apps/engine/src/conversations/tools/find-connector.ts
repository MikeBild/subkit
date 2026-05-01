// find_connector — fuzzy lookup over the saved-connector catalog.
// Same surface as find_workflow. Use when the operator says
// "do we have a Stripe connector?" before list_connectors.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "./index.ts";
import { keywordSearch } from "./keyword-search.ts";

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Free-text query. Matches id/slug/display_name/description/template_slug/driver/base_url. Use "*" or omit to list all.',
      ),
    id: z.string().min(1).optional().describe("Exact connector id; takes precedence over query."),
    environment: z
      .enum(["dev", "prod"])
      .optional()
      .describe("Filter to a specific environment. Default: both."),
    limit: z.number().int().min(1).max(50).default(15),
  })
  .openapi("FindConnectorToolInput");

interface ConnectorSummary {
  id: string;
  slug: string;
  display_name: string;
  driver: string;
  environment: string;
  template_slug: string | null;
  base_url: string | null;
  description: string | null;
  /**
   * Canonical request paths copied from the matching template's
   * `example_paths`. Surfaced so the propose-step LLM does not have to
   * guess `/v2` prefixes when the base_url already includes them.
   * Pre-fix session f00b8d1c emitted `/v2/projects` against a connector
   * with base_url `https://api.digitalocean.com/v2` and 404'd 19 times.
   */
  example_paths: string[];
}

function summarize(c: {
  id: string;
  slug: string;
  display_name: string;
  driver: string;
  environment: string;
  template_slug?: string | null;
  base_url?: string | null;
  operator_quirks?: Record<string, string | undefined> | null;
  template_snapshot?: unknown;
}): ConnectorSummary {
  const snap = (c.template_snapshot ?? null) as { example_paths?: unknown } | null;
  const examplePaths =
    snap && Array.isArray(snap.example_paths)
      ? snap.example_paths.filter((p): p is string => typeof p === "string")
      : [];
  // Surface the `general` quirk as the connector summary blurb so
  // discovery tools have a one-line human description without the
  // LLM dragging in auth/pagination/rate-limit detail it doesn't need
  // for ranking and selection.
  const description = c.operator_quirks?.general?.trim() || null;
  return {
    id: c.id,
    slug: c.slug,
    display_name: c.display_name,
    driver: c.driver,
    environment: c.environment,
    template_slug: c.template_slug ?? null,
    base_url: c.base_url ?? null,
    description,
    example_paths: examplePaths,
  };
}

function searchableText(s: ConnectorSummary): string {
  return [
    s.id,
    s.slug,
    s.display_name,
    s.driver,
    s.environment,
    s.template_slug ?? "",
    s.base_url ?? "",
    s.description ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export const findConnectorTool: ConversationTool = {
  name: "find_connector",
  description:
    "Look up saved connectors by exact id or free-text query. Keyword scoring across id/slug/name/description/template/driver/base_url. Use before list_connectors for tenants with many connectors.",
  use_case:
    'Operator says "do we already have a Stripe connector?" — find_connector returns ranked matches in one call.',
  important_notes: [
    "Returns at most `limit` matches (default 15).",
    "When `id` is supplied, only that connector is returned; query is ignored.",
    "`environment` filters to dev or prod (default: both).",
  ],
  inputSchema,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    if (args.id) {
      const c = await ctx.engineClient.connectors.get(args.id);
      if (!c) {
        return {
          ok: false,
          error_code: "connector_not_found",
          message: `no connector with id \`${args.id}\``,
          next_best_actions: ["find_connector", "list_connectors"],
        };
      }
      return { ok: true, data: { matches: [summarize(c)], total: 1 } };
    }
    const list = await ctx.engineClient.connectors.list();
    const filtered = args.environment
      ? list.filter((c) => c.environment === args.environment)
      : list;
    const summaries = filtered.map(summarize);
    const ranked = keywordSearch(args.query ?? "*", summaries, searchableText);
    const limited = ranked.slice(0, args.limit);
    return {
      ok: true,
      data: {
        matches: limited,
        total: ranked.length,
        ...(ranked.length > limited.length ? { truncated: true } : {}),
      },
    };
  },
};
