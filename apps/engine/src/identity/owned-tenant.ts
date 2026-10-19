import { and, eq, isNull } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { tenants } from "../db/schema/index.ts";
import { type BrowserMembershipContext, browserMembershipIdentity } from "./browser-memberships.ts";

export async function readOwnedTenant(input: BrowserMembershipContext, exec?: Executor) {
  const db = exec ?? getDb();
  const proof = await browserMembershipIdentity(input, db);
  const [tenant] = await db
    .select({
      id: tenants.id,
      display_name: tenants.display_name,
      status: tenants.status,
      deletion_requested_at: tenants.deletion_requested_at,
      deletion_scheduled_for: tenants.deletion_scheduled_for,
    })
    .from(tenants)
    .where(
      and(
        eq(tenants.owner_identity_id, proof.identity_id),
        eq(tenants.origin, "self_service"),
        isNull(tenants.deleted_at),
      ),
    )
    .limit(1);
  return tenant ?? null;
}
