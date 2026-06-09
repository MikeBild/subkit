// Connector read tools.

import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const ListInput = z.object({}).openapi("ListConnectorsToolInput");
const GetInput = z
  .object({ id: z.string().uuid("connector id must be a UUID") })
  .openapi("GetConnectorToolInput");

export const listConnectorsTool: ConversationTool = {
  name: "list_connectors",
  description: "List the tenant's connectors.",
  use_case:
    "Call early to find out which external systems the tenant has already configured; use the resulting slugs in placeholder tokens when authoring steps.",
  important_notes: [
    "Returns minimal metadata only (id, slug, driver, environment). Call get_connector for placeholder tokens and config.",
    `No credentials are returned here — use \${cred.<slug>.<field>} tokens, never inline values.`,
  ],
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx) {
    const rows = await ctx.engineClient.connectors.list();
    return {
      ok: true,
      data: {
        connectors: rows.map((c) => ({
          id: c.id,
          display_name: c.display_name,
          slug: c.slug,
          driver: c.driver,
          environment: c.environment,
          // Re-auth health so the LLM can spot broken connectors at a glance
          // and reach for request_connector_reauth.
          needs_reauth: c.needs_reauth,
          auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
        })),
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
  ],
  example_input: { id: "00000000-0000-0000-0000-000000000000" },
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = GetInput.parse(rawArgs);
    const c = await ctx.engineClient.connectors.get(args.id);
    if (!c) return { ok: false, data: { error: "connector_not_found" } };
    // Tell the LLM exactly which `${cred.<slug>.<field>}`, `${connector.<slug>.base_url}`,
    // and `${connector.<slug>.config.<path>}` tokens are available. Without this, the LLM
    // would have to guess credential field names from context, which is the #1 source of
    // broken workflows and inlined secrets.
    const placeholders = await ctx.engineClient.connectors.describePlaceholders(
      c.slug,
      c.environment as "dev" | "prod",
    );
    return {
      ok: true,
      data: {
        connector: {
          ...c,
          // Re-auth health surfaced explicitly with an ISO timestamp so the
          // LLM can flag a dead credential and reach for
          // request_connector_reauth instead of reporting empty results.
          needs_reauth: c.needs_reauth,
          auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
        },
        placeholders,
      },
    };
  },
};

export const connectorReadTools: ConversationTool[] = [listConnectorsTool, getConnectorTool];
