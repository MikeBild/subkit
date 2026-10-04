import { z } from "@hono/zod-openapi";
import { categoryOfConnector } from "../../../connectors/categorize.ts";
import { toPublicConnector } from "../../../connectors/public-view.ts";
import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    category: z
      .string()
      .optional()
      .describe(
        "Only connectors in this catalog block. A connector's block is its driver (http, graphql, postgres, s3, mcp) and is reported as `category` on every item.",
      ),
  })
  .openapi("ListConnectorsToolInput");
const GetInput = z
  .object({ id: z.string().uuid("connector id must be a UUID") })
  .openapi("GetConnectorToolInput");

export const listConnectorsTool: ConversationTool = {
  name: "list_connectors",
  description:
    "List the tenant's connectors. Each item carries a `category` (its driver) which is also filterable.",
  use_case:
    "Call early to find out which external systems the tenant has already configured; use the resulting slugs in placeholder tokens when authoring steps.",
  important_notes: [
    "Returns minimal metadata only (id, slug, driver, environment). Call get_connector for placeholder tokens and config.",
    `No credentials are returned here — use \${cred.<slug>.<field>} tokens, never inline values.`,
  ],
  inputSchema: ListInput,
  category: "tenant_read",
  permission: { action: "connector:read", resourceType: "connector" },
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const { rows, total } = await ctx.engineClient.connectors.list(
      args.category !== undefined ? { category: args.category } : {},
    );
    return {
      ok: true,
      data: {
        items: rows.map((c) => ({
          id: c.id,
          display_name: c.display_name,
          slug: c.slug,
          driver: c.driver,
          category: categoryOfConnector(c),
          environment: c.environment,
          needs_reauth: c.needs_reauth,
          auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
        })),
        total,
        returned: rows.length,
        offset: 0,
        has_more: rows.length < total,
      },
    };
  },
};

export const getConnectorTool: ConversationTool = {
  name: "get_connector",
  description:
    "Fetch a single connector by id, plus the placeholder tokens to use in workflow steps.",
  use_case: `Call before authoring a step that hits this connector — the returned \`placeholders\` field tells you exactly which \${cred.<slug>.<field>} and \${connector.<slug>.*} tokens are wired up in this environment.`,
  important_notes: [
    "`placeholders.credentials` is empty when no credential is configured; create one before writing a step that expects it.",
    "`placeholders` reflects the connector's active environment only — a dev connector does not expose prod tokens.",
    "Issues a `connector:read` RBAC check; low-privilege principals get `permission_denied` instead of the config.",
    "Secrets in `config` and the password inside `dsn` read as `***redacted***`. Send that value back unchanged in update_connector to keep the stored secret.",
  ],
  example_input: { id: "00000000-0000-0000-0000-000000000000" },
  inputSchema: GetInput,
  category: "tenant_read",
  permission: { action: "connector:read", resourceType: "connector", resourceIdArg: "id" },
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const c = await ctx.engineClient.connectors.get(args.id);
    if (!c) return { ok: false, data: { error: "connector_not_found" } };
    const placeholders = await ctx.engineClient.connectors.describePlaceholders(
      c.slug,
      c.environment as "dev" | "prod",
    );
    return {
      ok: true,
      data: {
        connector: {
          ...toPublicConnector(c),
          needs_reauth: c.needs_reauth,
          auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
        },
        placeholders,
      },
    };
  },
};

export const connectorReadTools: ConversationTool[] = [listConnectorsTool, getConnectorTool];
