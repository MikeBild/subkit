// find_connector — fuzzy lookup over the saved-connector catalog.
// Same surface as find_workflow. Use when the operator says
// "do we have a Stripe connector?" before list_connectors.

import { z } from "@hono/zod-openapi";

import { categoryOfConnector } from "../../connectors/categorize.ts";
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
    category: z
      .string()
      .optional()
      .describe(
        "Restrict the search to one catalog block. A connector's block is its driver (http, graphql, postgres, s3, mcp).",
      ),
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
  /**
   * Re-auth health. `true` when the connector's credential is dead and a
   * human must reconnect it (OAuth refresh revoked, API key rotated, login
   * lapsed). Surfaced so the LLM can flag broken connectors proactively and
   * reach for `request_connector_reauth` instead of reporting empty results.
   */
  needs_reauth: boolean;
  /** ISO timestamp of the first auth failure that flagged the connector, or null. */
  auth_failed_at: string | null;
  /** Catalog block — a connector's driver (`categoryOfConnector`). */
  category?: string;
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
  needs_reauth?: boolean;
  auth_failed_at?: Date | null;
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
    needs_reauth: c.needs_reauth ?? false,
    auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
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
  // Same connector inventory as list_connectors/get_connector — gate it
  // identically so search cannot bypass the connector:read requirement.
  permission: { action: "connector:read", resourceType: "connector", resourceIdArg: "id" },
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
    const { rows: list } = await ctx.engineClient.connectors.list(
      args.category !== undefined ? { category: args.category } : {},
    );
    const filtered = args.environment
      ? list.filter((c) => c.environment === args.environment)
      : list;
    const summaries = filtered.map((c) => ({ ...summarize(c), category: categoryOfConnector(c) }));
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
