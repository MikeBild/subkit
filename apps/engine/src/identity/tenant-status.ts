import { eq } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { tenants } from "../db/schema/identity.ts";

export class SelfServiceIdentityError extends Error {
  constructor(
    readonly code:
      | "registration_closed"
      | "registration_rate_limited"
      | "registration_policy_unavailable"
      | "identity_migration_required"
      | "membership_unavailable"
      | "tenant_unavailable",
  ) {
    super(code);
    this.name = "SelfServiceIdentityError";
  }
}

export async function assertTenantActive(tenantId: string, exec?: Executor): Promise<void> {
  const db = exec ?? getDb();
  const [tenant] = await db
    .select({ status: tenants.status, deleted_at: tenants.deleted_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (tenant?.status !== "active" || tenant.deleted_at !== null) {
    throw new SelfServiceIdentityError("tenant_unavailable");
  }
}

export async function lockActiveTenant(tenantId: string, tx: Executor): Promise<void> {
  const [tenant] = await tx
    .select({ status: tenants.status, deleted_at: tenants.deleted_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for("share")
    .limit(1);
  if (tenant?.status !== "active" || tenant.deleted_at !== null)
    throw new SelfServiceIdentityError("tenant_unavailable");
}
