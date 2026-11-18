import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Executor } from "../db/client.ts";
import { authIdentities, roles, tenants, userIdentities, users } from "../db/schema/index.ts";
import { seedDefaultCliNotificationRule } from "../notifications/default-cli-rule.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { isIanaTimeZone } from "../workflows/types.ts";
import { admitHostedTenantCreation } from "./hosted-admission.ts";
import { assertTenantActive, SelfServiceIdentityError } from "./tenant-status.ts";

const verifiedIdentitySchema = z
  .object({
    issuer_url: z.url().refine((value) => {
      const issuer = new URL(value);
      return (
        issuer.protocol === "https:" ||
        (issuer.protocol === "http:" && ["localhost", "127.0.0.1"].includes(issuer.hostname))
      );
    }),
    subject: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => value.trim() === value),
    email: z.string().trim().toLowerCase().pipe(z.email()),
    email_verified: z.literal(true),
  })
  .strict();

export type VerifiedSelfServiceIdentity = z.input<typeof verifiedIdentitySchema>;

export const WorkspaceRegistrationSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120),
    workspace_name: z.string().trim().min(1).max(120),
    timezone: z.string().min(1).max(64).refine(isIanaTimeZone, "unknown time zone"),
  })
  .strict();

export type WorkspaceRegistration = z.input<typeof WorkspaceRegistrationSchema>;

export { assertTenantActive, SelfServiceIdentityError } from "./tenant-status.ts";

export async function listMembershipsForIdentity(identityId: string, db: Executor) {
  return db
    .select({
      tenant_id: tenants.id,
      slug: tenants.slug,
      display_name: tenants.display_name,
      origin: tenants.origin,
      user_id: users.id,
      role_id: users.role_id,
      role: roles.name,
      is_owner: sql<boolean>`coalesce(${tenants.owner_identity_id} = ${identityId}, false)`,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenant_id))
    .innerJoin(
      roles,
      and(
        eq(roles.id, users.role_id),
        sql`(${roles.tenant_id} IS NULL OR ${roles.tenant_id} = ${users.tenant_id})`,
      ),
    )
    .where(
      and(
        eq(users.auth_identity_id, identityId),
        eq(users.status, "active"),
        isNull(users.deleted_at),
        eq(tenants.status, "active"),
        isNull(tenants.deleted_at),
      ),
    )
    .orderBy(tenants.created_at, tenants.id);
}

export async function getMembershipForIdentity(identityId: string, tenantId: string, db: Executor) {
  const memberships = await listMembershipsForIdentity(identityId, db);
  return memberships.find((membership) => membership.tenant_id === tenantId) ?? null;
}

type VerifiedIdentity = z.output<typeof verifiedIdentitySchema>;

async function lockVerifiedIdentity(input: VerifiedIdentity, tx: Executor) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.issuer_url, input.subject])}, 0))`,
  );
  // tenant-filter:exempt — verified issuer and subject resolve a global login identity before a tenant exists.
  const [existingIdentity] = await tx
    .select()
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.issuer_url, input.issuer_url),
        eq(authIdentities.subject, input.subject),
      ),
    )
    .limit(1);
  // tenant-filter:exempt — verified issuer and subject detect historical bindings without admitting them as memberships.
  const historicalBindings = await tx
    .select({ auth_identity_id: users.auth_identity_id })
    .from(userIdentities)
    .innerJoin(
      users,
      and(eq(users.id, userIdentities.user_id), eq(users.tenant_id, userIdentities.tenant_id)),
    )
    .where(
      and(
        eq(userIdentities.issuer_url, input.issuer_url),
        eq(userIdentities.subject, input.subject),
        isNull(userIdentities.product_id),
      ),
    );
  if (
    historicalBindings.some(
      (binding) => !existingIdentity || binding.auth_identity_id !== existingIdentity.id,
    )
  ) {
    throw new SelfServiceIdentityError("identity_migration_required");
  }
  const identity =
    existingIdentity ??
    (
      await tx
        .insert(authIdentities)
        .values({ issuer_url: input.issuer_url, subject: input.subject, email: input.email })
        .returning()
    )[0];
  assertInsertRow(identity, "auth_identities");
  return identity;
}

export async function provisionSelfServiceTenant(
  raw: VerifiedSelfServiceIdentity,
  rawRegistration: WorkspaceRegistration,
  db: Executor,
) {
  const input = verifiedIdentitySchema.parse(raw);
  const registration = WorkspaceRegistrationSchema.parse(rawRegistration);
  return db.transaction(async (tx) => {
    const identity = await lockVerifiedIdentity(input, tx);
    const [existingTenant] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.owner_identity_id, identity.id))
      .limit(1);
    if (existingTenant) {
      await assertTenantActive(existingTenant.id, tx);
      const membership = await getMembershipForIdentity(identity.id, existingTenant.id, tx);
      if (!membership) throw new SelfServiceIdentityError("membership_unavailable");
      if (identity.email !== input.email) {
        await tx
          .update(authIdentities)
          .set({ email: input.email, updated_at: new Date() })
          .where(eq(authIdentities.id, identity.id));
        await auditAwait(
          {
            tenant_id: existingTenant.id,
            actor_type: "user",
            actor_id: membership.user_id,
            action: AuditAction.USER_PROFILE_UPDATED,
            resource_type: "auth_identity",
            resource_id: identity.id,
            result: "success",
            metadata: { source: "verified_oidc_email_update" },
          },
          tx,
        );
      }
      return {
        identity: { ...identity, email: input.email },
        tenant: existingTenant,
        membership,
        created: false,
      };
    }
    await admitHostedTenantCreation(tx);
    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug: randomUUID(),
        display_name: registration.workspace_name,
        timezone: registration.timezone,
        origin: "self_service",
        status: "active",
        is_operator: false,
        owner_identity_id: identity.id,
      })
      .returning();
    assertInsertRow(tenant, "tenants");
    const [user] = await tx
      .insert(users)
      .values({
        tenant_id: tenant.id,
        auth_identity_id: identity.id,
        email: input.email,
        display_name: registration.display_name,
        role_id: await builtinRoleId(tx, "admin"),
        status: "active",
      })
      .returning();
    assertInsertRow(user, "users");
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.TENANT_CREATED,
        resource_type: "tenant",
        resource_id: tenant.id,
        result: "success",
        metadata: { origin: tenant.origin, owner_identity_id: identity.id },
      },
      tx,
    );
    await auditAwait(
      {
        tenant_id: tenant.id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.USER_CREATED,
        resource_type: "user",
        resource_id: user.id,
        result: "success",
        metadata: { source: "self_service", role_id: user.role_id },
      },
      tx,
    );
    await seedDefaultCliNotificationRule(tx, tenant.id);
    if (identity.email !== input.email) {
      await tx
        .update(authIdentities)
        .set({ email: input.email, updated_at: new Date() })
        .where(eq(authIdentities.id, identity.id));
    }
    const membership = await getMembershipForIdentity(identity.id, tenant.id, tx);
    if (!membership) throw new SelfServiceIdentityError("membership_unavailable");
    return { identity: { ...identity, email: input.email }, tenant, membership, created: true };
  });
}

export async function resolveHostedIdentity(
  raw: VerifiedSelfServiceIdentity,
  options: { registration_enabled: boolean },
  db: Executor,
) {
  const input = verifiedIdentitySchema.parse(raw);
  // tenant-filter:exempt — verified issuer and subject establish the identity before selecting an existing membership.
  const [identity] = await db
    .select()
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.issuer_url, input.issuer_url),
        eq(authIdentities.subject, input.subject),
      ),
    )
    .limit(1);
  if (identity) {
    const memberships = await listMembershipsForIdentity(identity.id, db);
    const membership = memberships.find((entry) => entry.is_owner) ?? memberships[0];
    if (membership) {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, membership.tenant_id))
        .limit(1);
      if (!tenant) throw new SelfServiceIdentityError("tenant_unavailable");
      if (identity.email !== input.email) {
        await db.transaction(async (tx) => {
          await tx
            .update(authIdentities)
            .set({ email: input.email, updated_at: new Date() })
            .where(eq(authIdentities.id, identity.id));
          await auditAwait(
            {
              tenant_id: tenant.id,
              actor_type: "user",
              actor_id: membership.user_id,
              action: AuditAction.USER_PROFILE_UPDATED,
              resource_type: "auth_identity",
              resource_id: identity.id,
              result: "success",
              metadata: { source: "verified_oidc_email_update" },
            },
            tx,
          );
        });
      }
      return {
        kind: "member" as const,
        identity: { ...identity, email: input.email },
        tenant,
        membership,
      };
    }
    const [owned] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.owner_identity_id, identity.id))
      .limit(1);
    if (owned) throw new SelfServiceIdentityError("tenant_unavailable");
  }
  if (!options.registration_enabled) throw new SelfServiceIdentityError("registration_closed");
  const pending = await db.transaction(async (tx) => {
    const locked = await lockVerifiedIdentity(input, tx);
    if (locked.email === input.email) return locked;
    await tx
      .update(authIdentities)
      .set({ email: input.email, updated_at: new Date() })
      .where(eq(authIdentities.id, locked.id));
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.USER_PROFILE_UPDATED,
        resource_type: "auth_identity",
        resource_id: locked.id,
        result: "success",
        metadata: { source: "verified_oidc_email_update" },
      },
      tx,
    );
    return { ...locked, email: input.email };
  });
  return { kind: "registration" as const, identity: pending };
}

export async function completeHostedRegistration(
  identityId: string,
  registration: WorkspaceRegistration,
  options: { registration_enabled: boolean },
  db: Executor,
) {
  // tenant-filter:exempt — a verified registration proof names the global identity that is about to own a workspace.
  const [identity] = await db
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.id, identityId))
    .limit(1);
  if (!identity) throw new SelfServiceIdentityError("membership_unavailable");
  const [owned] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.owner_identity_id, identity.id))
    .limit(1);
  if (!owned && !options.registration_enabled)
    throw new SelfServiceIdentityError("registration_closed");
  return provisionSelfServiceTenant(
    {
      issuer_url: identity.issuer_url,
      subject: identity.subject,
      email: identity.email,
      email_verified: true,
    },
    registration,
    db,
  );
}

export function parseVerifiedSelfServiceIdentity(raw: VerifiedSelfServiceIdentity) {
  return verifiedIdentitySchema.parse(raw);
}
