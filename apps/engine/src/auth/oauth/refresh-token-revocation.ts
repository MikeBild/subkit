import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import {
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
} from "../../db/schema/index.ts";

export async function revokeOAuthRefreshTokenFamily(
  db: Executor,
  refreshId: string,
  tenantId: string,
  revokedAt: Date,
  excludedAccessTokenId?: string,
): Promise<void> {
  const [refresh] = await db
    .select({
      grant_id: mcpOauthRefreshTokens.grant_id,
      client_id: mcpOauthRefreshTokens.client_id,
      tenant_id: mcpOauthRefreshTokens.tenant_id,
    })
    .from(mcpOauthRefreshTokens)
    .where(
      and(eq(mcpOauthRefreshTokens.id, refreshId), eq(mcpOauthRefreshTokens.tenant_id, tenantId)),
    )
    .limit(1);

  if (!refresh) return;

  // tenant-filter:exempt — OAuth clients are platform-global and have no tenant_id.
  await db
    .select({ client_id: mcpOauthClients.client_id })
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.client_id, refresh.client_id))
    .for("update");

  if (refresh.grant_id) {
    await db
      .select({ id: mcpOauthGrants.id })
      .from(mcpOauthGrants)
      .where(
        and(
          eq(mcpOauthGrants.id, refresh.grant_id),
          eq(mcpOauthGrants.tenant_id, refresh.tenant_id),
          eq(mcpOauthGrants.client_id, refresh.client_id),
        ),
      )
      .for("update");
  }

  await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, rotated_to_id
      FROM mcp_oauth_refresh_tokens
      WHERE id = ${refreshId}
        AND tenant_id = ${refresh.tenant_id}
        AND client_id = ${refresh.client_id}
      UNION
      SELECT r.id, r.rotated_to_id
      FROM mcp_oauth_refresh_tokens r
      INNER JOIN chain c ON r.id = c.rotated_to_id OR c.id = r.rotated_to_id
      WHERE r.tenant_id = ${refresh.tenant_id}
        AND r.client_id = ${refresh.client_id}
    )
    UPDATE mcp_oauth_refresh_tokens
    SET revoked_at = ${revokedAt}
    WHERE id IN (SELECT id FROM chain)
      AND revoked_at IS NULL
  `);

  await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, rotated_to_id
      FROM mcp_oauth_refresh_tokens
      WHERE id = ${refreshId}
        AND tenant_id = ${refresh.tenant_id}
        AND client_id = ${refresh.client_id}
      UNION
      SELECT r.id, r.rotated_to_id
      FROM mcp_oauth_refresh_tokens r
      INNER JOIN chain c ON r.id = c.rotated_to_id OR c.id = r.rotated_to_id
      WHERE r.tenant_id = ${refresh.tenant_id}
        AND r.client_id = ${refresh.client_id}
    )
    UPDATE mcp_oauth_access_tokens
    SET revoked_at = ${revokedAt}
    WHERE refresh_token_id IN (SELECT id FROM chain)
      AND tenant_id = ${refresh.tenant_id}
      AND client_id = ${refresh.client_id}
      AND revoked_at IS NULL
      AND (${excludedAccessTokenId ?? null}::uuid IS NULL OR id <> ${excludedAccessTokenId ?? null}::uuid)
  `);

  if (refresh.grant_id) {
    await db
      .update(mcpOauthGrants)
      .set({ revoked_at: revokedAt })
      .where(
        and(
          eq(mcpOauthGrants.id, refresh.grant_id),
          eq(mcpOauthGrants.tenant_id, refresh.tenant_id),
          eq(mcpOauthGrants.client_id, refresh.client_id),
          isNull(mcpOauthGrants.revoked_at),
        ),
      );
  } else {
    await db
      .insert(mcpOauthUnknownGrants)
      .values({ tenant_id: refresh.tenant_id, client_id: refresh.client_id })
      .onConflictDoNothing();
  }
}
