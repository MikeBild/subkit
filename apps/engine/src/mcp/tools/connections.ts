import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { type ConnectionView, listConnections } from "../../credentials/connections/index.ts";
import type { Db } from "../../db/client.ts";

export const LIST_CONNECTIONS_TOOL_NAME = "list_connections";

export const listConnectionsMcpTool: Tool = {
  name: LIST_CONNECTIONS_TOOL_NAME,
  description:
    "List the tenant's outbound connections (OAuth grants SubKit holds at other services), as GET /v1/connections returns them: state and its reason, auto_renew (true = a refresh token is stored and the grant renews itself before expiry; false with expires_at = it ends then unless a person renews it), expires_at, the permission scopes (protocol scopes such as offline_access are left out) and used_by — the connectors whose credential points at the grant. Tokens are never returned.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Connections",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export async function handleListConnections(ctx: {
  db: Db;
  principal: ResolvedPrincipal;
}): Promise<{ ok: true; data: { items: ConnectionView[] } }> {
  return { ok: true, data: { items: await listConnections(ctx.db, ctx.principal.tenant_id) } };
}
