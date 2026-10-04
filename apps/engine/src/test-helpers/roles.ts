import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { roles } from "../db/schema/index.ts";

const EMPTY_ROLE_NAME = "no-permissions";

export async function emptyRoleId(exec: Executor, tenant_id: string): Promise<string> {
  const [existing] = await exec
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.tenant_id, tenant_id), eq(roles.name, EMPTY_ROLE_NAME)))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await exec
    .insert(roles)
    .values({ tenant_id, name: EMPTY_ROLE_NAME, description: "grants nothing", is_builtin: false })
    .returning({ id: roles.id });
  if (!row) throw new Error("empty role insert returned no row");
  return row.id;
}
