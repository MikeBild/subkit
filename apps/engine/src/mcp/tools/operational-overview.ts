import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { getOperationalOverview } from "../../operator/operational-overview.ts";

export const OPERATIONAL_OVERVIEW_TOOL_NAME = "get_operational_overview";

export const operationalOverviewMcpTool: Tool = {
  name: OPERATIONAL_OVERVIEW_TOOL_NAME,
  description:
    "Read the role-aware operational snapshot used by the SubKit cockpit and metrics projection.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Operational overview",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export async function handleOperationalOverview(ctx: {
  db: Db;
  principal: ResolvedPrincipal;
}): Promise<{ ok: true; data: unknown }> {
  return { ok: true, data: await getOperationalOverview(ctx.db, ctx.principal.tenant_id) };
}
