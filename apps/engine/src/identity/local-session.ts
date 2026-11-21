import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { apiKeys, engineSettings, tenants, users } from "../db/schema/index.ts";
import { seedTenantBootstrap } from "../db/seed.ts";
import {
  BOOTSTRAP_COMPLETED_KEY,
  BOOTSTRAP_TOKEN_KEY,
  deriveTenantSlug,
} from "../onboarding/bootstrap.ts";
import { seedBuiltinRolesAndPermissions } from "../rbac/seed.ts";

export const LOCAL_OWNER_SETTING = "local_workspace.owner";
export const LOCAL_OWNER_FALLBACK_EMAIL = "owner@local-workspace.invalid";
const BOOTSTRAP_LOCK = "subkit:bootstrap";
const CONTROL_CHARACTERS = /\p{Cc}/u;

const DisplayText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed");

export const LocalOwnerSchema = z
  .object({
    name: DisplayText(120),
    email: z.string().trim().email().max(254).optional(),
    workspace_name: DisplayText(120).optional(),
  })
  .strict();

export type LocalOwner = z.infer<typeof LocalOwnerSchema>;

export const LocalSessionRequestSchema = z
  .object({
    device_id: z.string().uuid(),
    device_label: DisplayText(64),
    owner: LocalOwnerSchema.optional(),
  })
  .strict();

export type LocalSessionRequest = z.infer<typeof LocalSessionRequestSchema>;

const LocalOwnerRecordSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

export type LocalOwnerOutcome =
  | { ok: true; tenant_id: string; user_id: string; created: boolean }
  | { ok: false; code: "owner_required" | "not_local_workspace" | "owner_unavailable" | "busy" };

async function readOwnerRecord(db: Db) {
  const [row] = await db
    .select({ value: engineSettings.value })
    .from(engineSettings)
    .where(eq(engineSettings.key, LOCAL_OWNER_SETTING))
    .limit(1);
  if (!row) return null;
  const parsed = LocalOwnerRecordSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
}

async function writeEngineSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(engineSettings)
    .values({ key, value, updated_by: null })
    .onConflictDoUpdate({
      target: engineSettings.key,
      set: { value, updated_by: null, updated_at: new Date() },
    });
}

async function activeOwner(db: Db, record: { tenant_id: string; user_id: string }) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, record.user_id),
        eq(users.tenant_id, record.tenant_id),
        eq(users.status, "active"),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  return Boolean(user);
}

async function revokeBootstrapKey(db: Db, tenantId: string, prefix: string): Promise<void> {
  const revoked = await db
    .update(apiKeys)
    .set({ revoked_at: new Date() })
    .where(
      and(eq(apiKeys.tenant_id, tenantId), eq(apiKeys.prefix, prefix), isNull(apiKeys.revoked_at)),
    )
    .returning({ id: apiKeys.id });
  for (const key of revoked)
    await auditAwait(
      {
        tenant_id: tenantId,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.API_KEY_REVOKED,
        resource_type: "api_key",
        resource_id: key.id,
        result: "success",
        reason: "local_workspace_owner_signs_in_with_a_session",
        metadata: { prefix, source: "local_session" },
      },
      db,
    );
}

async function provisionOwner(db: Db, owner: LocalOwner) {
  const rbacIds = await seedBuiltinRolesAndPermissions(db);
  const workspaceName = owner.workspace_name ?? owner.name;
  const result = await seedTenantBootstrap(db, rbacIds, {
    admin_email: owner.email ?? LOCAL_OWNER_FALLBACK_EMAIL,
    tenant_name: workspaceName,
    tenant_slug: deriveTenantSlug(workspaceName),
    create_metrics_key: false,
  });
  if (result.api_key) await revokeBootstrapKey(db, result.tenant_id, result.api_key.prefix);
  await db
    .update(users)
    .set({ display_name: owner.name, updated_at: new Date() })
    .where(and(eq(users.id, result.user_id), eq(users.tenant_id, result.tenant_id)));
  await writeEngineSetting(db, BOOTSTRAP_COMPLETED_KEY, true);
  await db.delete(engineSettings).where(eq(engineSettings.key, BOOTSTRAP_TOKEN_KEY));
  await writeEngineSetting(db, LOCAL_OWNER_SETTING, {
    tenant_id: result.tenant_id,
    user_id: result.user_id,
  });
  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.SETUP_COMPLETED,
      resource_type: "bootstrap",
      resource_id: result.tenant_id,
      result: "success",
      metadata: {
        tenant_id: result.tenant_id,
        via: "local_session",
        email_given: owner.email !== undefined,
      },
    },
    db,
  );
  return { tenant_id: result.tenant_id, user_id: result.user_id };
}

export async function ensureLocalOwner(
  db: Db,
  owner: LocalOwner | undefined,
): Promise<LocalOwnerOutcome> {
  const existing = await readOwnerRecord(db);
  if (existing) {
    if (!(await activeOwner(db, existing))) return { ok: false, code: "owner_unavailable" };
    return { ok: true, ...existing, created: false };
  }
  return await db.transaction(async (tx) => {
    const claim = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${BOOTSTRAP_LOCK}, 0)) as claimed`,
    )) as unknown as { rows: Array<{ claimed: boolean }> };
    if (claim.rows[0]?.claimed !== true) return { ok: false, code: "busy" } as const;
    const raced = await readOwnerRecord(db);
    if (raced) return { ok: true, ...raced, created: false } as const;
    const [anyTenant] = await db.select({ id: tenants.id }).from(tenants).limit(1);
    if (anyTenant) return { ok: false, code: "not_local_workspace" } as const;
    if (!owner) return { ok: false, code: "owner_required" } as const;
    const created = await provisionOwner(db, owner);
    return { ok: true, ...created, created: true } as const;
  });
}
