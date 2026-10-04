import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { roles, users } from "../db/schema/index.ts";

export async function resolveChatPrincipal(
  db: Db,
  tenant_id: string,
  user_id: string,
): Promise<ResolvedPrincipal> {
  const rows = await db
    .select({ role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.tenant_id, tenant_id), eq(users.id, user_id)))
    .limit(1);
  const row = rows[0];
  return {
    provider: "chat",
    kind: "user",
    id: user_id,
    tenant_id,
    roles: row?.role_name ? [row.role_name] : [],
  };
}
