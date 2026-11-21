import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { hostedControlReceiptId } from "../db/hosted-control-receipt.ts";
import {
  type CockpitInstallationKind,
  cockpitInstallations,
} from "../db/schema/cockpit-installations.ts";
import { sessions } from "../db/schema/identity.ts";
import { revokeDeviceRunnersForInstallation } from "../devices/registry.ts";
import { endCockpitPushForSessions } from "./cockpit-push.ts";

export const COCKPIT_INSTALLATION_LIST_MAX = 50;

export interface CockpitInstallation {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  kind: CockpitInstallationKind;
  device_id: string | null;
  device_label: string | null;
  revoked_at: Date | null;
}

export interface CockpitInstallationListing extends CockpitInstallation {
  created_at: Date;
  last_used_at: Date | null;
}

export interface DesktopDevice {
  device_id: string;
  device_label: string;
}

const INSTALLATION_COLUMNS = {
  id: cockpitInstallations.id,
  tenant_id: cockpitInstallations.tenant_id,
  owner_user_id: cockpitInstallations.owner_user_id,
  kind: cockpitInstallations.kind,
  device_id: cockpitInstallations.device_id,
  device_label: cockpitInstallations.device_label,
  revoked_at: cockpitInstallations.revoked_at,
};

function activeInstallationWhere(tenantId: string, ownerUserId: string) {
  return and(
    eq(cockpitInstallations.tenant_id, tenantId),
    eq(cockpitInstallations.owner_user_id, ownerUserId),
    eq(cockpitInstallations.kind, "browser"),
    isNull(cockpitInstallations.revoked_at),
  );
}

function activeDesktopWhere(tenantId: string, ownerUserId: string, deviceId: string) {
  return and(
    eq(cockpitInstallations.tenant_id, tenantId),
    eq(cockpitInstallations.owner_user_id, ownerUserId),
    eq(cockpitInstallations.kind, "desktop"),
    eq(cockpitInstallations.device_id, deviceId),
    isNull(cockpitInstallations.revoked_at),
  );
}

export async function getActiveCockpitInstallation(
  db: Db,
  tenantId: string,
  ownerUserId: string,
): Promise<CockpitInstallation | null> {
  const rows = await db
    .select(INSTALLATION_COLUMNS)
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
    .select(INSTALLATION_COLUMNS)
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
    .returning(INSTALLATION_COLUMNS);
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
      metadata: { kind: "browser" },
    },
    db,
  );
  return { installation, created: true };
}

export async function listActiveCockpitInstallations(
  db: Db,
  tenantId: string,
  ownerUserId: string,
): Promise<CockpitInstallationListing[]> {
  return await db
    .select({
      ...INSTALLATION_COLUMNS,
      created_at: cockpitInstallations.created_at,
      last_used_at:
        sql<Date | null>`(select max(used.last_seen_at) from ${sessions} as used where used.installation_id = ${sql.raw('"cockpit_installations"."id"')} and used.tenant_id = ${sql.raw('"cockpit_installations"."tenant_id"')})`.mapWith(
          (value: string | Date | null) => (value === null ? null : new Date(value)),
        ),
    })
    .from(cockpitInstallations)
    .where(
      and(
        eq(cockpitInstallations.tenant_id, tenantId),
        eq(cockpitInstallations.owner_user_id, ownerUserId),
        isNull(cockpitInstallations.revoked_at),
      ),
    )
    .orderBy(asc(cockpitInstallations.created_at), asc(cockpitInstallations.id))
    .limit(COCKPIT_INSTALLATION_LIST_MAX);
}

async function getActiveDesktopInstallation(
  db: Db,
  tenantId: string,
  ownerUserId: string,
  deviceId: string,
): Promise<CockpitInstallation | null> {
  const rows = await db
    .select(INSTALLATION_COLUMNS)
    .from(cockpitInstallations)
    .where(activeDesktopWhere(tenantId, ownerUserId, deviceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function createOrReuseDesktopInstallation(
  db: Db,
  tenantId: string,
  ownerUserId: string,
  device: DesktopDevice,
): Promise<{ installation: CockpitInstallation; created: boolean }> {
  const existing = await getActiveDesktopInstallation(db, tenantId, ownerUserId, device.device_id);
  if (existing) {
    if (existing.device_label === device.device_label)
      return { installation: existing, created: false };
    const renamed = await db
      .update(cockpitInstallations)
      .set({ device_label: device.device_label, updated_at: new Date() })
      .where(
        and(
          eq(cockpitInstallations.id, existing.id),
          activeDesktopWhere(tenantId, ownerUserId, device.device_id),
        ),
      )
      .returning(INSTALLATION_COLUMNS);
    return { installation: renamed[0] ?? existing, created: false };
  }

  const created = await db
    .insert(cockpitInstallations)
    .values({
      tenant_id: tenantId,
      owner_user_id: ownerUserId,
      kind: "desktop",
      device_id: device.device_id,
      device_label: device.device_label,
    })
    .onConflictDoNothing()
    .returning(INSTALLATION_COLUMNS);
  const installation =
    created[0] ?? (await getActiveDesktopInstallation(db, tenantId, ownerUserId, device.device_id));
  if (!installation) throw new Error("desktop installation was not created");
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
      metadata: { kind: "desktop", device_id: device.device_id, device_label: device.device_label },
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
      .returning({ id: cockpitInstallations.id, kind: cockpitInstallations.kind });
    const [revoked] = rows;
    if (!revoked) return false;
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
    await revokeDeviceRunnersForInstallation(tx, {
      tenant_id: tenantId,
      installation_id: installationId,
      actor_id: ownerUserId,
      reason: "installation_revoked",
    });
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
