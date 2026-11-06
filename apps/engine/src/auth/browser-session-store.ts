import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { sessions } from "../db/schema/index.ts";
import { endCockpitPushForSessions } from "../identity/index.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import { browserSessionDenyReason } from "./browser-session-validity.ts";

export interface OwnedSessionKey {
  session_id: string;
  tenant_id: string;
  user_id: string;
}

export interface OwnedSessionRow {
  auth_identity_id: string | null;
  expires_at: Date;
  absolute_expires_at: Date | null;
}

export async function touchSessionIfLive(
  db: Db,
  sessionId: string,
  tenantId: string,
): Promise<boolean> {
  const rows = await db
    .select({
      revoked_at: sessions.revoked_at,
      expires_at: sessions.expires_at,
      last_seen_at: sessions.last_seen_at,
      absolute_expires_at: sessions.absolute_expires_at,
    })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId)))
    .limit(1);
  const row = rows[0];
  const now = Date.now();
  if (!row || browserSessionDenyReason(row, new Date(now))) return false;

  await db
    .update(sessions)
    .set({ last_seen_at: new Date(now), expires_at: new Date(now + 8 * 60 * 60 * 1000) })
    .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId)));
  return true;
}

export async function findOwnedSession(
  db: Db,
  key: OwnedSessionKey,
): Promise<OwnedSessionRow | null> {
  const [row] = await db
    .select({
      auth_identity_id: sessions.auth_identity_id,
      expires_at: sessions.expires_at,
      absolute_expires_at: sessions.absolute_expires_at,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, key.session_id),
        eq(sessions.tenant_id, key.tenant_id),
        eq(sessions.user_id, key.user_id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findSessionProduct(
  db: Db,
  sessionId: string,
  tenantId: string,
): Promise<{ product_id: string | null } | null> {
  const [row] = await db
    .select({ product_id: sessions.product_id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.tenant_id, tenantId)))
    .limit(1);
  return row ?? null;
}

export async function revokeSessionForAccountSwitch(
  db: Db,
  input: {
    session_id: string;
    tenant_id: string;
    user_id: string;
    request_source: RequestSource | undefined;
  },
): Promise<void> {
  await db
    .update(sessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(sessions.id, input.session_id), eq(sessions.tenant_id, input.tenant_id)));
  await endCockpitPushForSessions(
    db,
    { tenant_id: input.tenant_id, session_ids: [input.session_id] },
    "session_replaced",
    { actor_type: "user", actor_id: input.user_id },
  );
  await auditAwait(
    {
      tenant_id: input.tenant_id,
      actor_type: "user",
      actor_id: input.user_id,
      action: AuditAction.SESSION_REVOKED,
      resource_type: "session",
      resource_id: input.session_id,
      result: "success",
      reason: "switch_account",
      metadata: { request_source: input.request_source, via: "mcp_oauth_consent" },
    },
    db,
  );
}
