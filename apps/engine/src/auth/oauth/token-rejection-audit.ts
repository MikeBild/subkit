import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";

export async function auditOAuthTokenRejected(
  db: Db,
  tenantId: string,
  requestSource: string,
  reason: string,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: tenantId,
      actor_type: "system",
      action: AuditAction.MCP_OAUTH_TOKEN_REJECTED,
      resource_type: "mcp_oauth_token",
      resource_id: null,
      result: "denied",
      metadata: { request_source: requestSource, reason },
    },
    db,
  );
}
