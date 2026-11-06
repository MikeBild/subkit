import { and, eq, isNull, ne } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../audit/types.ts";
import { OperatorTenantMissingError } from "../rbac/operator.ts";
import { createDbFromUrl, type Db } from "./client.ts";
import { tenants } from "./schema/index.ts";

interface OperatorAssignment {
  tenant_id: string;
  tenant_slug: string;
  previous_tenant_id: string | null;
}

export function parseSetOperatorTenantArgs(argv: string[]): { tenantSlug: string } {
  const index = argv.indexOf("--set-operator-tenant");
  const slug = index >= 0 ? argv[index + 1] : undefined;
  if (!slug || slug.startsWith("--")) {
    throw new Error(
      "--set-operator-tenant needs a tenant slug, e.g. engine --set-operator-tenant default",
    );
  }
  return { tenantSlug: slug };
}

export async function assignOperatorTenant(
  db: Db,
  tenantSlug: string,
): Promise<OperatorAssignment> {
  return db.transaction(async (tx) => {
    // tenant-filter:exempt — the operator tenant is chosen by slug across all tenants
    const [target] = await tx
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.slug, tenantSlug), isNull(tenants.deleted_at)))
      .limit(1)
      .for("update");
    if (!target || target.id === SYSTEM_TENANT_ID) {
      throw new OperatorTenantMissingError(`tenant slug '${tenantSlug}' not found`);
    }
    // tenant-filter:exempt — the previous operator tenant row is located by its flag
    const [previous] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.is_operator, true))
      .limit(1)
      .for("update");
    if (previous?.id !== target.id) {
      await tx
        .update(tenants)
        .set({ is_operator: false })
        .where(and(eq(tenants.is_operator, true), ne(tenants.id, target.id)));
      await tx.update(tenants).set({ is_operator: true }).where(eq(tenants.id, target.id));
    }
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.TENANT_OPERATOR_ASSIGNED,
        resource_type: "tenant",
        resource_id: target.id,
        result: "success",
        metadata: {
          tenant_slug: target.slug,
          previous_tenant_id: previous?.id ?? null,
          request_source: "cli",
        },
      },
      tx,
    );
    return {
      tenant_id: target.id,
      tenant_slug: target.slug,
      previous_tenant_id: previous?.id ?? null,
    };
  });
}

export async function setOperatorTenantFromUrl(
  databaseUrl: string,
  tenantSlug: string,
): Promise<OperatorAssignment> {
  const { pool, db } = createDbFromUrl(databaseUrl);
  try {
    return await assignOperatorTenant(db, tenantSlug);
  } finally {
    await pool.end();
  }
}
