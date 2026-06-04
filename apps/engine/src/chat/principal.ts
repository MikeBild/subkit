// Synthetic chat principal resolver.
//
// Chat surfaces (slash `/run`, conversation turns, elicitation
// responses) gate on RBAC the same way HTTP/MCP do, but the inbound
// event carries only a resolved chat identity → subkit `user_id`, not
// a full `ResolvedPrincipal`. This helper assembles the synthetic
// principal out of that identity so the evaluator can walk the
// role/group/grant ladder and the admin short-circuit fires when the
// linked user's enum role warrants it.
//
// Fail-closed: an unlinked or missing user yields EMPTY roles. There is
// deliberately no default/admin/system fallback — RBAC denies, which is
// the correct outcome for an identity we cannot resolve.

import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { users } from "../db/schema/index.ts";

export async function resolveChatPrincipal(
  db: Db,
  tenant_id: string,
  user_id: string,
): Promise<ResolvedPrincipal> {
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(and(eq(users.tenant_id, tenant_id), eq(users.id, user_id)))
    .limit(1);
  const row = rows[0];
  return {
    provider: "chat",
    kind: "user",
    id: user_id,
    tenant_id,
    roles: row ? [row.role] : [],
  };
}
