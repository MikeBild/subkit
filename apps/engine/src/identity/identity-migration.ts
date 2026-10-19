import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { authIdentities, tenants, userIdentities, users } from "../db/schema/index.ts";
import { isOperatorPrincipal, principalHolds } from "../rbac/index.ts";
import { assertTenantActive } from "./self-service.ts";

export const IdentityMigrationInput = z
  .object({
    issuer_url: z.url(),
    subject: z.string().min(1).max(1024),
    reviewed_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export class IdentityMigrationError extends Error {
  constructor(readonly code: "operator_required" | "migration_review_stale") {
    super(code);
    this.name = "IdentityMigrationError";
  }
}

export async function migrateProviderIdentity(
  raw: z.input<typeof IdentityMigrationInput>,
  actor: ResolvedPrincipal,
  exec?: Executor,
) {
  const input = IdentityMigrationInput.parse(raw);
  const db = exec ?? getDb();
  if (
    !(await isOperatorPrincipal(db, actor)) ||
    !(await principalHolds(db, actor, "identity:write"))
  ) {
    throw new IdentityMigrationError("operator_required");
  }
  return db.transaction(async (tx) => {
    await assertTenantActive(actor.tenant_id, tx);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.issuer_url, input.subject])}, 0))`,
    );
    // tenant-filter:exempt — an authorized engine operator reviews exact existing issuer and subject bindings across tenants.
    const bindings = await tx
      .select({
        binding_id: userIdentities.id,
        tenant_id: users.tenant_id,
        user_id: users.id,
        email: userIdentities.email,
        role_id: users.role_id,
        auth_identity_id: users.auth_identity_id,
        user_status: users.status,
        user_deleted_at: users.deleted_at,
        tenant_status: tenants.status,
        tenant_deleted_at: tenants.deleted_at,
      })
      .from(userIdentities)
      .innerJoin(
        users,
        and(eq(users.id, userIdentities.user_id), eq(users.tenant_id, userIdentities.tenant_id)),
      )
      .innerJoin(tenants, eq(tenants.id, users.tenant_id))
      .where(
        and(
          eq(userIdentities.issuer_url, input.issuer_url),
          eq(userIdentities.subject, input.subject),
          isNull(userIdentities.product_id),
        ),
      )
      .orderBy(userIdentities.id)
      .for("update");
    // tenant-filter:exempt — exact issuer and subject identify the global login binding being explicitly migrated.
    const [identity] = await tx
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.issuer_url, input.issuer_url),
          eq(authIdentities.subject, input.subject),
        ),
      )
      .limit(1);
    const conflicts: string[] = [];
    if (bindings.length === 0) conflicts.push("no_pinned_bindings");
    const tenantUsers = new Map<string, string>();
    for (const binding of bindings) {
      if (
        binding.user_deleted_at ||
        binding.user_status !== "active" ||
        binding.tenant_deleted_at ||
        binding.tenant_status !== "active"
      )
        conflicts.push(`binding_inactive:${binding.binding_id}`);
      if (binding.auth_identity_id && binding.auth_identity_id !== identity?.id)
        conflicts.push(`identity_conflict:${binding.binding_id}`);
      const existingUser = tenantUsers.get(binding.tenant_id);
      if (existingUser && existingUser !== binding.user_id)
        conflicts.push(`tenant_user_conflict:${binding.tenant_id}`);
      tenantUsers.set(binding.tenant_id, binding.user_id);
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          issuer: input.issuer_url,
          subject: input.subject,
          identity_id: identity?.id ?? null,
          bindings,
        }),
      )
      .digest("hex");
    if (input.reviewed_digest && input.reviewed_digest !== digest)
      throw new IdentityMigrationError("migration_review_stale");
    if (!input.reviewed_digest || conflicts.length > 0)
      return {
        applied: false,
        digest,
        conflicts: [...new Set(conflicts)],
        bindings,
        identity_id: identity?.id ?? null,
      };
    const target =
      identity ??
      (
        await tx
          .insert(authIdentities)
          .values({
            issuer_url: input.issuer_url,
            subject: input.subject,
            email: bindings[0]?.email ?? "",
          })
          .returning()
      )[0];
    assertInsertRow(target, "auth_identities");
    for (const binding of bindings) {
      if (binding.auth_identity_id === target.id) continue;
      await tx
        .update(users)
        .set({ auth_identity_id: target.id, updated_at: new Date() })
        .where(and(eq(users.id, binding.user_id), eq(users.tenant_id, binding.tenant_id)));
      await auditAwait(
        {
          tenant_id: binding.tenant_id,
          actor_type: actor.kind,
          actor_id: actor.id,
          action: AuditAction.USER_IDENTITY_LINKED,
          resource_type: "user",
          resource_id: binding.user_id,
          result: "success",
          metadata: {
            source: "operator_identity_migration",
            auth_identity_id: target.id,
            reviewed_digest: digest,
          },
        },
        tx,
      );
    }
    return { applied: true, digest, conflicts: [], bindings, identity_id: target.id };
  });
}
