import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { revokeOAuthRefreshTokenFamily } from "./refresh-token-revocation.ts";

export async function revokeOAuthRefreshChain(
  db: Db,
  refreshId: string,
  tenantId: string,
  userId: string,
  now: Date,
): Promise<void> {
  await db.transaction((tx) => revokeOAuthRefreshTokenFamily(tx, refreshId, tenantId, now));
  await auditAwait(
    {
      tenant_id: tenantId,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.MCP_OAUTH_TOKEN_REVOKED,
      resource_type: "mcp_oauth_token",
      resource_id: refreshId,
      result: "success",
      metadata: {
        request_source: "api",
        reason: "replay_detected",
        chain_revoked: true,
        affected_user_id: userId,
      },
    },
    db,
  );
  logger.warn({
    module: "mcp_oauth",
    action: "token.chain_revoked",
    msg: "refresh token replay detected — chain revoked",
    refresh_token_id: refreshId,
    tenant_id: tenantId,
  });
}
