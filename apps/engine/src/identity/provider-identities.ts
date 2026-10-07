import { z } from "@hono/zod-openapi";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { getConfig } from "../config/loader.ts";
import type { Executor } from "../db/client.ts";
import { tenants, userIdentities, users } from "../db/schema/index.ts";
import { RequestSourceSchema } from "../observability/index.ts";
import { now } from "../utils/clock.ts";

const inputSchema = z
  .object({
    tenant_id: z.string().uuid(),
    user_id: z.string().uuid(),
    provider_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    subject: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          value.trim() === value &&
          !Array.from(value).some((char) => {
            const code = char.charCodeAt(0);
            return code < 32 || code === 127;
          }),
      ),
    actor_id: z.string(),
    actor_kind: z.enum(["user", "system_account"]),
    request_source: RequestSourceSchema,
  })
  .strict();

export class ProviderIdentityBindingError extends Error {
  constructor(
    readonly code:
      | "provider_unavailable"
      | "provider_tenant_mismatch"
      | "user_unavailable"
      | "identity_binding_conflict",
  ) {
    super(code);
  }
}

export async function bindProviderIdentity(raw: z.input<typeof inputSchema>, db: Executor) {
  const input = inputSchema.parse(raw);
  const provider = getConfig().auth.providers.find((entry) => entry.id === input.provider_id);
  if (provider?.protocol !== "oidc") throw new ProviderIdentityBindingError("provider_unavailable");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.tenant_id}:${input.provider_id}:identity`}, 0))`,
    );
    const [tenant] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, input.tenant_id), eq(tenants.slug, provider.tenant_slug)))
      .limit(1);
    if (!tenant) throw new ProviderIdentityBindingError("provider_tenant_mismatch");
    const [user] = await tx
      .select()
      .from(users)
      .where(
        and(
          eq(users.tenant_id, input.tenant_id),
          eq(users.id, input.user_id),
          eq(users.status, "active"),
          isNull(users.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!user) throw new ProviderIdentityBindingError("user_unavailable");
    const [existing] = await tx
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.tenant_id, input.tenant_id),
          eq(userIdentities.provider_id, provider.id),
          or(eq(userIdentities.subject, input.subject), eq(userIdentities.user_id, user.id)),
        ),
      )
      .limit(1);
    const product = provider.product_id ?? null;
    const auditMetadata = {
      user_id: user.id,
      provider_id: provider.id,
      issuer_url: provider.issuer_url,
      product_id: product,
    };
    if (existing) {
      if (
        existing.user_id !== user.id ||
        existing.subject !== input.subject ||
        (existing.issuer_url !== null && existing.issuer_url !== provider.issuer_url) ||
        (existing.issuer_url !== null && existing.product_id !== product) ||
        (existing.product_id !== null && existing.product_id !== product)
      )
        throw new ProviderIdentityBindingError("identity_binding_conflict");
      if (existing.issuer_url === provider.issuer_url && existing.product_id === product)
        return { binding: existing, replayed: true };
      const [pinned] = await tx
        .update(userIdentities)
        .set({ issuer_url: provider.issuer_url, product_id: product, updated_at: new Date(now()) })
        .where(
          and(eq(userIdentities.tenant_id, input.tenant_id), eq(userIdentities.id, existing.id)),
        )
        .returning();
      if (!pinned) throw new ProviderIdentityBindingError("identity_binding_conflict");
      await auditBinding(pinned.id, true);
      return { binding: pinned, replayed: false };
    }
    const [created] = await tx
      .insert(userIdentities)
      .values({
        tenant_id: input.tenant_id,
        user_id: user.id,
        provider_id: provider.id,
        issuer_url: provider.issuer_url,
        product_id: product,
        subject: input.subject,
        email: user.email,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) throw new ProviderIdentityBindingError("identity_binding_conflict");
    await auditBinding(created.id, false);
    return { binding: created, replayed: false };

    async function auditBinding(identity_id: string, legacy_pin: boolean) {
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          actor_type: input.actor_kind,
          actor_id: input.actor_id,
          action: AuditAction.USER_IDENTITY_LINKED,
          resource_type: "user_identity",
          resource_id: identity_id,
          result: "success",
          metadata: {
            ...auditMetadata,
            request_source: input.request_source,
            legacy_pin,
          },
        },
        tx,
      );
    }
  });
}
