import { z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { type Executor, getDb } from "../db/client.ts";
import {
  apiKeys,
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  portalTokens,
  sessions,
  tenants,
  userInvites,
} from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { type BrowserMembershipContext, browserMembershipIdentity } from "./browser-memberships.ts";

const deletionInput = z
  .object({
    tenant_id: z.uuid(),
    user_id: z.uuid(),
    session_id: z.uuid(),
    confirmation: z.string().min(1).max(200),
  })
  .strict();
const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class TenantLifecycleError extends Error {
  constructor(
    readonly code:
      | "tenant_owner_required"
      | "tenant_deletion_unavailable"
      | "tenant_confirmation_mismatch"
      | "tenant_restore_unavailable",
  ) {
    super(code);
    this.name = "TenantLifecycleError";
  }
}

export async function requestOwnedTenantDeletion(
  raw: BrowserMembershipContext & { confirmation: string },
  exec?: Executor,
) {
  const input = deletionInput.parse(raw);
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const proof = await browserMembershipIdentity(input, tx);
    const [tenant] = await tx
      .select()
      .from(tenants)
      .where(
        and(
          eq(tenants.id, input.tenant_id),
          eq(tenants.owner_identity_id, proof.identity_id),
          eq(tenants.origin, "self_service"),
          isNull(tenants.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!tenant) throw new TenantLifecycleError("tenant_owner_required");
    if (tenant.display_name !== input.confirmation)
      throw new TenantLifecycleError("tenant_confirmation_mismatch");
    if (tenant.status !== "active") throw new TenantLifecycleError("tenant_deletion_unavailable");
    const timestamp = new Date(now());
    const deadline = new Date(timestamp.getTime() + DELETION_GRACE_MS);
    await tx
      .update(tenants)
      .set({
        status: "pending_deletion",
        deletion_requested_at: timestamp,
        deletion_scheduled_for: deadline,
        updated_at: timestamp,
      })
      .where(eq(tenants.id, input.tenant_id));
    await tx
      .update(sessions)
      .set({ revoked_at: timestamp })
      .where(and(eq(sessions.tenant_id, input.tenant_id), isNull(sessions.revoked_at)));
    await tx
      .update(apiKeys)
      .set({ revoked_at: timestamp })
      .where(and(eq(apiKeys.tenant_id, input.tenant_id), isNull(apiKeys.revoked_at)));
    await tx
      .update(portalTokens)
      .set({ revoked_at: timestamp })
      .where(and(eq(portalTokens.tenant_id, input.tenant_id), isNull(portalTokens.revoked_at)));
    await tx
      .update(userInvites)
      .set({ revoked_at: timestamp })
      .where(and(eq(userInvites.tenant_id, input.tenant_id), isNull(userInvites.revoked_at)));
    await tx
      .update(mcpOauthAuthorizationCodes)
      .set({ consumed_at: timestamp })
      .where(
        and(
          eq(mcpOauthAuthorizationCodes.tenant_id, input.tenant_id),
          isNull(mcpOauthAuthorizationCodes.consumed_at),
        ),
      );
    await tx
      .update(mcpOauthGrants)
      .set({ revoked_at: timestamp })
      .where(and(eq(mcpOauthGrants.tenant_id, input.tenant_id), isNull(mcpOauthGrants.revoked_at)));
    await tx
      .update(mcpOauthAccessTokens)
      .set({ revoked_at: timestamp })
      .where(
        and(
          eq(mcpOauthAccessTokens.tenant_id, input.tenant_id),
          isNull(mcpOauthAccessTokens.revoked_at),
        ),
      );
    await tx
      .update(mcpOauthRefreshTokens)
      .set({ revoked_at: timestamp })
      .where(
        and(
          eq(mcpOauthRefreshTokens.tenant_id, input.tenant_id),
          isNull(mcpOauthRefreshTokens.revoked_at),
        ),
      );
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: "user",
        actor_id: input.user_id,
        action: AuditAction.TENANT_DELETION_REQUESTED,
        resource_type: "tenant",
        resource_id: input.tenant_id,
        result: "success",
        metadata: { deletion_scheduled_for: deadline.toISOString() },
      },
      tx,
    );
    return {
      tenant_id: input.tenant_id,
      status: "pending_deletion" as const,
      deletion_scheduled_for: deadline,
    };
  });
}

export async function restoreOwnedTenant(identityId: string, tx: Executor) {
  const ownerIdentityId = z.uuid().parse(identityId);
  const [tenant] = await tx
    .select()
    .from(tenants)
    .where(
      and(
        eq(tenants.owner_identity_id, ownerIdentityId),
        eq(tenants.origin, "self_service"),
        isNull(tenants.deleted_at),
      ),
    )
    .for("update")
    .limit(1);
  if (
    tenant?.status !== "pending_deletion" ||
    !tenant.deletion_scheduled_for ||
    tenant.deletion_scheduled_for.getTime() <= now()
  ) {
    throw new TenantLifecycleError("tenant_restore_unavailable");
  }
  const timestamp = new Date(now());
  await tx
    .update(tenants)
    .set({
      status: "active",
      deletion_requested_at: null,
      deletion_scheduled_for: null,
      updated_at: timestamp,
    })
    .where(eq(tenants.id, tenant.id));
  await auditAwait(
    {
      tenant_id: tenant.id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.TENANT_RESTORED,
      resource_type: "tenant",
      resource_id: tenant.id,
      result: "success",
      metadata: { via: "verified_identity_recovery" },
    },
    tx,
  );
  return { tenant_id: tenant.id, status: "active" as const };
}
