import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listConnectionsOperation } from "../../api/operations/connection.ts";
import { actorOfPrincipal, isRejection, type OperationScope } from "../../api/operations/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import type { ToolCategory, ToolDescriptor, ToolEnvelope } from "../../tools/types.ts";
import { zodToJsonSchema7 } from "../json-schema.ts";

const ListConnectionsInput = z.object({}).strict();

const readOnly = listConnectionsOperation.effect === "read";

function gatePermission(): string {
  const permission = listConnectionsOperation.permission;
  if (permission === null) throw new Error(`${listConnectionsOperation.id} has no permission`);
  return permission;
}

export const listConnectionsMcpTool: Tool = {
  name: "list_connections",
  description:
    "List the tenant's outbound connections (OAuth grants SubKit holds at other services), as GET /v1/connections returns them: state and its reason, auto_renew (true = a refresh token is stored and the grant renews itself before expiry; false with expires_at = it ends then unless a person renews it), expires_at, the permission scopes (protocol scopes such as offline_access are left out) and used_by — the connectors whose credential points at the grant. Tokens are never returned.",
  inputSchema: zodToJsonSchema7(ListConnectionsInput) as Tool["inputSchema"],
  annotations: {
    title: "Connections",
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const listConnectionsCategory: ToolCategory = readOnly ? "tenant_read" : "tenant_write";

export const listConnectionsRbac: NonNullable<ToolDescriptor["rbac"]> = {
  permission: gatePermission(),
};

export async function invokeListConnections(ctx: {
  db: Db;
  principal: ResolvedPrincipal;
}): Promise<ToolEnvelope> {
  const http = listConnectionsOperation.http;
  if (!http) throw new Error(`${listConnectionsOperation.id} has no HTTP binding`);
  const scope: OperationScope = {
    db: ctx.db,
    tenant_id: ctx.principal.tenant_id,
    principal: ctx.principal,
    actor: actorOfPrincipal(ctx.principal),
  };
  const outcome = await listConnectionsOperation.handler(scope, {});
  if (isRejection(outcome))
    return { status: "error", error_code: outcome.code, message: outcome.message };
  return { status: "ok", data: http.toBody(outcome, scope) };
}
