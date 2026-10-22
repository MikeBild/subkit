import { and, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { hostedControlReceiptId } from "../db/hosted-control-receipt.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { sessions } from "../db/schema/identity.ts";
import { endCockpitPushForSessions } from "./cockpit-push.ts";

export interface CockpitInstallation {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  revoked_at: Date | null;
}

function activeInstallationWhere(tenantId: string, ownerUserId: string) {
  return and(
    eq(cockpitInstallations.tenant_id, tenantId),
    eq(cockpitInstallations.owner_user_id, ownerUserId),
    isNull(cockpitInstallations.revoked_at),
  );
}

export async function getActiveCockpitInstallation(
  db: Db,
  tenantId: string,
  ownerUserId: string,
): Promise<CockpitInstallation | null> {
  const rows = await db
    .select({
      id: cockpitInstallations.id,
      tenant_id: cockpitInstallations.tenant_id,
      owner_user_id: cockpitInstallations.owner_user_id,
      revoked_at: cockpitInstallations.revoked_at,
    })
    .from(cockpitInstallations)
    .where(activeInstallationWhere(tenantId, ownerUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getCockpitInstallation(
  db: Db,
  installationId: string,
): Promise<CockpitInstallation | null> {
  // tenant-filter:exempt — installation lookup is followed by tenant and owner binding at the request boundary.
  const rows = await db
    .select({
      id: cockpitInstallations.id,
      tenant_id: cockpitInstallations.tenant_id,
      owner_user_id: cockpitInstallations.owner_user_id,
      revoked_at: cockpitInstallations.revoked_at,
    })
    .from(cockpitInstallations)
    .where(eq(cockpitInstallations.id, installationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function createOrReuseCockpitInstallation(
  db: Db,
  tenantId: string,
  ownerUserId: string,
): Promise<{ installation: CockpitInstallation; created: boolean }> {
  const existing = await getActiveCockpitInstallation(db, tenantId, ownerUserId);
  if (existing) return { installation: existing, created: false };

  const created = await db
    .insert(cockpitInstallations)
    .values({ tenant_id: tenantId, owner_user_id: ownerUserId })
    .onConflictDoNothing()
    .returning({
      id: cockpitInstallations.id,
      tenant_id: cockpitInstallations.tenant_id,
      owner_user_id: cockpitInstallations.owner_user_id,
      revoked_at: cockpitInstallations.revoked_at,
    });
  const installation =
    created[0] ?? (await getActiveCockpitInstallation(db, tenantId, ownerUserId));
  if (!installation) throw new Error("cockpit installation was not created");
  if (created.length === 0) return { installation, created: false };

  await auditAwait(
    {
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: ownerUserId,
      action: AuditAction.COCKPIT_INSTALLATION_CREATED,
      resource_type: "cockpit_installation",
      resource_id: installation.id,
      result: "success",
      metadata: {},
    },
    db,
  );
  return { installation, created: true };
}

export async function revokeCockpitInstallation(
  db: Db,
  installationId: string,
  tenantId: string,
  ownerUserId: string,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .update(cockpitInstallations)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(cockpitInstallations.id, installationId),
          eq(cockpitInstallations.tenant_id, tenantId),
          eq(cockpitInstallations.owner_user_id, ownerUserId),
          isNull(cockpitInstallations.revoked_at),
        ),
      )
      .returning({ id: cockpitInstallations.id });
    if (rows.length === 0) return false;
    const revokedSessions = await tx
      .update(sessions)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(sessions.tenant_id, tenantId),
          eq(sessions.installation_id, installationId),
          isNull(sessions.revoked_at),
        ),
      )
      .returning({ id: sessions.id });
    await endCockpitPushForSessions(
      tx,
      { tenant_id: tenantId, installation_id: installationId },
      "installation_revoked",
      { actor_type: "user", actor_id: ownerUserId },
    );
    for (const session of revokedSessions) {
      await auditAwait(
        {
          id: hostedControlReceiptId(tenantId, "session", session.id),
          tenant_id: tenantId,
          actor_type: "user",
          actor_id: ownerUserId,
          action: AuditAction.SESSION_REVOKED,
          resource_type: "session",
          resource_id: session.id,
          result: "success",
          reason: "installation_revoked",
          metadata: { installation_id: installationId },
        },
        tx,
      );
    }
    await auditAwait(
      {
        id: hostedControlReceiptId(tenantId, "cockpit_installation", installationId),
        tenant_id: tenantId,
        actor_type: "user",
        actor_id: ownerUserId,
        action: AuditAction.COCKPIT_INSTALLATION_REVOKED,
        resource_type: "cockpit_installation",
        resource_id: installationId,
        result: "success",
        metadata: { revoked_session_count: revokedSessions.length },
      },
      tx,
    );
    return true;
  });
}
