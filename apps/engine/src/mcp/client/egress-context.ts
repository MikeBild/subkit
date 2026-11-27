import {
  type EgressGuardContext,
  type LocalMcpScope,
  localMcpScopeFor,
} from "../../connectors/index.ts";
import type { Executor } from "../../db/index.ts";
import type { McpConnectorRow } from "./registry.ts";

export function mcpLocalScope(
  row: Pick<McpConnectorRow, "url" | "tls">,
): LocalMcpScope | undefined {
  return localMcpScopeFor(row.url, row.tls);
}

export function mcpEgressContext(
  tenant_id: string,
  exec: Executor,
  row: Pick<McpConnectorRow, "url" | "tls">,
): EgressGuardContext {
  const local_mcp = mcpLocalScope(row);
  return { tenant_id, exec, ...(local_mcp ? { local_mcp } : {}) };
}
