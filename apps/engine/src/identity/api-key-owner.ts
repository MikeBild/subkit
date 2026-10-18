import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { systemAccounts, users } from "../db/schema/index.ts";

export class ApiKeyOwnerNotFoundError extends Error {
  readonly code = "not_found";
  constructor(readonly owner_kind: "user" | "system_account") {
    super(`${owner_kind} not found`);
  }
}

export async function assertApiKeyOwnerInTenant(
  tx: Executor,
  tenantId: string,
  ownerKind: "user" | "system_account",
  ownerId: string,
): Promise<void> {
  const rows =
    ownerKind === "user"
      ? await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(eq(users.tenant_id, tenantId), eq(users.id, ownerId), isNull(users.deleted_at)),
          )
          .limit(1)
      : await tx
          .select({ id: systemAccounts.id })
          .from(systemAccounts)
          .where(
            and(
              eq(systemAccounts.tenant_id, tenantId),
              eq(systemAccounts.id, ownerId),
              isNull(systemAccounts.deleted_at),
            ),
          )
          .limit(1);
  if (rows.length === 0) throw new ApiKeyOwnerNotFoundError(ownerKind);
}
