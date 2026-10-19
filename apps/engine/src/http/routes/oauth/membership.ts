import type { Executor } from "../../../db/client.ts";
import {
  type BrowserMembershipContext,
  browserMembershipIdentity,
  getMembershipForIdentity,
  SelfServiceIdentityError,
} from "../../../identity/index.ts";

export async function resolveAuthorizationMembership(
  session: BrowserMembershipContext,
  tenantId: string | undefined,
  db: Executor,
) {
  if (!tenantId || tenantId === session.tenant_id) {
    return { tenant_id: session.tenant_id, user_id: session.user_id };
  }
  const identity = await browserMembershipIdentity(session, db);
  const membership = await getMembershipForIdentity(identity.identity_id, tenantId, db);
  if (!membership) throw new SelfServiceIdentityError("membership_unavailable");
  return { tenant_id: membership.tenant_id, user_id: membership.user_id };
}
