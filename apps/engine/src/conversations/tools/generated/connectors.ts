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
        })),
      },
    };
  },
};

export const getConnectorTool: ConversationTool = {
  name: "get_connector",
  description: "Fetch a single connector by id.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = GetInput.parse(rawArgs);
    const c = await ctx.engineClient.connectors.get(args.id);
    if (!c) return { ok: false, data: { error: "connector_not_found" } };
    return { ok: true, data: { connector: c } };
  },
};

export const connectorReadTools: ConversationTool[] = [listConnectorsTool, getConnectorTool];
