import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { userIdentities } from "../db/schema/index.ts";
import {
  type ErasureFollowUp,
  type ErasureOperator,
  eraseProductCaller,
} from "../identity/product-erasure.ts";
import type { AppTenant } from "./apps.ts";

export interface ErasedAppUser {
  user_id: string;
  app_id: string;
  erased: true;
}

interface AppUserKeptByOtherAccess {
  kept: true;
  reason: "other_access";
}

export async function eraseAppUser(
  db: Db,
  tenant: AppTenant,
  operator: ErasureOperator,
  appId: string,
  userId: string,
): Promise<ErasedAppUser | AppUserKeptByOtherAccess | null> {
  let followUp: ErasureFollowUp | null = null;
  const outcome = await db.transaction(async (tx) => {
    followUp = null;
    const [identity] = await tx
      .select({ provider_id: userIdentities.provider_id, subject: userIdentities.subject })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.tenant_id, tenant.tenant_id),
          eq(userIdentities.user_id, userId),
          eq(userIdentities.product_id, appId),
        ),
      )
      .limit(1)
      .for("update");
    if (!identity) return null;
    const [other] = await tx
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.tenant_id, tenant.tenant_id),
          eq(userIdentities.user_id, userId),
          or(isNull(userIdentities.product_id), ne(userIdentities.product_id, appId)),
        ),
      )
      .limit(1);
    if (other) return { kept: true as const, reason: "other_access" as const };
    followUp = await eraseProductCaller(
      tx,
      {
        tenantId: tenant.tenant_id,
        principalId: userId,
        principalKind: "user",
        provider: identity.provider_id,
        productId: appId,
        subject: identity.subject,
      },
      { kind: "operator", operator },
    );
    return { user_id: userId, app_id: appId, erased: true as const };
  });
  await (followUp as ErasureFollowUp | null)?.(db);
  return outcome;
}
