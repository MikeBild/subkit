import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { productSubjectDigest } from "../auth/identity-link.ts";
import type { Executor } from "../db/client.ts";
import {
  apiKeys,
  callerBudgetUnits,
  executions,
  productIdentityTombstones,
  sessions,
  userIdentities,
  users,
} from "../db/schema/index.ts";

export interface ErasableCaller {
  tenantId: string;
  principalId: string;
  principalKind: "user" | "system_account";
  provider: string;
  productId: string | null;
  subject?: string | null | undefined;
}

function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: "caller_erasure_unavailable" });
}

export async function eraseProductCaller(
  tx: Executor,
  caller: ErasableCaller,
  context: { execution_id: string; now?: Date },
): Promise<void> {
  if (caller.principalKind !== "user" || !caller.productId || !caller.subject)
    refuse("caller erasure needs a product user with a verified subject");
  const subject = caller.subject;
  const now = context.now ?? new Date();
  const [identity] = await tx
    .select({ id: userIdentities.id, issuer_url: userIdentities.issuer_url })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.tenant_id, caller.tenantId),
        eq(userIdentities.user_id, caller.principalId),
        eq(userIdentities.provider_id, caller.provider),
        eq(userIdentities.subject, subject),
        eq(userIdentities.product_id, caller.productId),
      ),
    )
    .limit(1);
  if (!identity) refuse("the caller's product identity is no longer bound");
  await tx
    .delete(callerBudgetUnits)
    .where(
      and(
        eq(callerBudgetUnits.tenant_id, caller.tenantId),
        eq(callerBudgetUnits.principal_id, caller.principalId),
      ),
    );
  await tx
    .delete(userIdentities)
    .where(
      and(
        eq(userIdentities.tenant_id, caller.tenantId),
        eq(userIdentities.user_id, caller.principalId),
      ),
    );
  await tx
    .update(sessions)
    .set({ revoked_at: now })
    .where(
      and(
        eq(sessions.tenant_id, caller.tenantId),
        eq(sessions.user_id, caller.principalId),
        isNull(sessions.revoked_at),
      ),
    );
  await tx
    .update(apiKeys)
    .set({ revoked_at: now })
    .where(
      and(
        eq(apiKeys.tenant_id, caller.tenantId),
        eq(apiKeys.user_id, caller.principalId),
        isNull(apiKeys.revoked_at),
      ),
    );
  await tx
    .update(users)
    .set({
      status: "disabled",
      deleted_at: now,
      email: `erased:${caller.principalId}@invalid`,
      display_name: null,
    })
    .where(and(eq(users.tenant_id, caller.tenantId), eq(users.id, caller.principalId)));
  await tx
    .insert(productIdentityTombstones)
    .values({
      tenant_id: caller.tenantId,
      provider_id: caller.provider,
      issuer_url: identity.issuer_url ?? "",
      subject_sha256: productSubjectDigest(subject),
      erased_at: now,
    })
    .onConflictDoUpdate({
      target: [
        productIdentityTombstones.tenant_id,
        productIdentityTombstones.provider_id,
        productIdentityTombstones.subject_sha256,
      ],
      set: { erased_at: now, issuer_url: identity.issuer_url ?? "" },
    });
  await tx
    .update(executions)
    .set({ caller_context: sql`jsonb_set(${executions.caller_context}, '{subject}', 'null')` })
    .where(
      and(
        eq(executions.tenant_id, caller.tenantId),
        sql`${executions.caller_context}->>'principalId' = ${caller.principalId}`,
        sql`${executions.caller_context} ? 'subject'`,
      ),
    );
  await auditAwait(
    {
      tenant_id: caller.tenantId,
      actor_type: "user",
      actor_id: caller.principalId,
      action: AuditAction.USER_DELETED,
      resource_type: "user",
      resource_id: caller.principalId,
      result: "success",
      metadata: {
        source: "caller_erasure",
        product_id: caller.productId,
        provider_id: caller.provider,
        execution_id: context.execution_id,
      },
    },
    tx,
  );
}
