import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { cockpitInstallations } from "../../db/schema/cockpit-installations.ts";
import { userIdentities, users } from "../../db/schema/index.ts";

export interface CockpitInstallation {
  id: string;
  tenant_id: string;
  owner_user_id: string;
}

interface CockpitInstallationIdentity extends CockpitInstallation {
  auth_identity_id: string | null;
}

export async function findActiveCockpitInstallation(
  db: Db,
  installationId: string,
): Promise<CockpitInstallation | null> {
  // tenant-filter:exempt — installation login starts before an authenticated tenant exists.
  const [installation] = await db
    .select({
      id: cockpitInstallations.id,
      tenant_id: cockpitInstallations.tenant_id,
      owner_user_id: cockpitInstallations.owner_user_id,
    })
    .from(cockpitInstallations)
    .where(
      and(eq(cockpitInstallations.id, installationId), isNull(cockpitInstallations.revoked_at)),
    )
    .limit(1);
  return installation ?? null;
}

export async function findActiveCockpitInstallationForTenant(
  db: Db,
  installationId: string,
  tenantId: string,
): Promise<CockpitInstallation | null> {
  const [installation] = await db
    .select({
      id: cockpitInstallations.id,
      tenant_id: cockpitInstallations.tenant_id,
      owner_user_id: cockpitInstallations.owner_user_id,
    })
    .from(cockpitInstallations)
    .where(
      and(
        eq(cockpitInstallations.id, installationId),
        eq(cockpitInstallations.tenant_id, tenantId),
        isNull(cockpitInstallations.revoked_at),
      ),
    )
    .limit(1);
  return installation ?? null;
}

export async function findCockpitInstallationIdentity(
  db: Db,
  opts: {
    installationId: string;
    tenantId: string;
    providerId: string;
    subject: string;
    issuerUrl: string;
    productId?: string;
  },
): Promise<CockpitInstallationIdentity | null> {
  const [identity] = await db
    .select({
      id: cockpitInstallations.id,
      tenant_id: cockpitInstallations.tenant_id,
      owner_user_id: cockpitInstallations.owner_user_id,
      auth_identity_id: users.auth_identity_id,
    })
    .from(cockpitInstallations)
    .innerJoin(
      userIdentities,
      and(
        eq(userIdentities.tenant_id, cockpitInstallations.tenant_id),
        eq(userIdentities.user_id, cockpitInstallations.owner_user_id),
      ),
    )
    .innerJoin(
      users,
      and(eq(users.tenant_id, userIdentities.tenant_id), eq(users.id, userIdentities.user_id)),
    )
    .where(
      and(
        eq(cockpitInstallations.id, opts.installationId),
        eq(cockpitInstallations.tenant_id, opts.tenantId),
        isNull(cockpitInstallations.revoked_at),
        eq(userIdentities.provider_id, opts.providerId),
        eq(userIdentities.subject, opts.subject),
        eq(userIdentities.issuer_url, opts.issuerUrl),
        opts.productId === undefined
          ? isNull(userIdentities.product_id)
          : eq(userIdentities.product_id, opts.productId),
        eq(users.status, "active"),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  return identity ?? null;
}
