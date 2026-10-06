import { z } from "@hono/zod-openapi";
import { listedDescription } from "../../api/catalog-metadata.ts";
import { rankedPage } from "./catalog-rank.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Free-text query. Matches id/slug/display_name/description/category/template_slug/driver/base_url. Use "*" or omit to list all.',
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
        "Restrict the search to one catalog block (see `category` on each match). Categories are shared with workflows, knowledge sources, skills and files.",
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
  example_paths: string[];
  needs_reauth: boolean;
  auth_failed_at: string | null;
  category: string;
}

function summarize(c: {
  id: string;
  slug: string;
  display_name: string;
  driver: string;
  environment: string;
  template_slug?: string | null;
  base_url?: string | null;
  description: string | null;
  category: string;
  template_snapshot?: unknown;
  needs_reauth?: boolean;
  auth_failed_at?: Date | null;
}): ConnectorSummary {
  const snap = (c.template_snapshot ?? null) as { example_paths?: unknown } | null;
  const examplePaths =
    snap && Array.isArray(snap.example_paths)
      ? snap.example_paths.filter((p): p is string => typeof p === "string")
      : [];
  return {
    id: c.id,
    slug: c.slug,
    display_name: c.display_name,
    driver: c.driver,
    environment: c.environment,
    template_slug: c.template_slug ?? null,
    base_url: c.base_url ?? null,
    description: listedDescription(c.description),
    category: c.category,
    example_paths: examplePaths,
    needs_reauth: c.needs_reauth ?? false,
    auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
  };
}

function rankFields(s: ConnectorSummary) {
  return {
    category: [s.category],
    identity: [s.slug, s.display_name, s.template_slug],
    description: [s.description],
    detail: [s.driver, s.base_url, ...s.example_paths],
  };
}

export const findConnectorTool: ConversationTool = {
  name: "find_connector",
  description:
    "Look up saved connectors by exact id or free-text query. Matches are ranked by category, slug and name, description, then driver and base URL, and each says why it matched (`reasons`). Use before list_connectors for tenants with many connectors.",
  use_case:
    'Operator says "do we already have a Stripe connector?" — find_connector returns ranked matches in one call.',
  important_notes: [
    "Returns at most `limit` matches (default 15).",
    "When `id` is supplied, only that connector is returned; query is ignored.",
    "`environment` filters to dev or prod (default: both).",
  ],
  inputSchema,
  category: "tenant_read",
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
    const summaries = filtered.map(summarize);
    return {
      ok: true,
      data: rankedPage(args.query, summaries, rankFields, args.limit, "list_connectors"),
    };
  },
};
