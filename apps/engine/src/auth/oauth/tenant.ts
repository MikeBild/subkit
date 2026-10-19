import { and, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { users } from "../../db/schema/index.ts";
import { assertTenantActive, SelfServiceIdentityError } from "../../identity/index.ts";
import { type LivenessRefusal, userLivenessRefusal } from "../liveness.ts";

export async function assertOAuthTenantActive(tenantId: string, db: Executor): Promise<void> {
  try {
    await assertTenantActive(tenantId, db);
  } catch (error) {
    if (error instanceof SelfServiceIdentityError) {
      throw Object.assign(new Error("invalid_grant: workspace is unavailable"), {
        oauth_error: "invalid_grant",
        oauth_reason: "tenant_unavailable",
      });
    }
    throw error;
  }
}

export async function oauthUserLiveness(
  db: Executor,
  tenantId: string,
  userId: string,
  lock = false,
): Promise<LivenessRefusal | null> {
  const query = db
    .select({ status: users.status, deleted_at: users.deleted_at })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.tenant_id, tenantId)));
  const rows = await (lock ? query.for("update") : query.limit(1));
  return userLivenessRefusal(rows[0]);
}
