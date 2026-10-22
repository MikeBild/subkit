import type { Db } from "../db/client.ts";
import { withTenantWork } from "../execution/index.ts";
import { listCockpitPushTenants } from "../identity/index.ts";
import { withIsolatedContext } from "../logging/context.ts";
import { dispatchCockpitPushAttention } from "../notifications/cockpit-push-attention.ts";

export async function runCockpitPushAttention(
  db: Db,
  at: Date,
  dispatch: typeof dispatchCockpitPushAttention = dispatchCockpitPushAttention,
): Promise<string[]> {
  const tenantIds = await listCockpitPushTenants(db, at);
  for (const tenantId of tenantIds)
    await withTenantWork(tenantId, () =>
      withIsolatedContext(
        { tenant_id: tenantId, request_source: "scheduler", actor_id: "scheduler" },
        () => dispatch(db, tenantId, { now: at }),
      ),
    );
  return tenantIds;
}
