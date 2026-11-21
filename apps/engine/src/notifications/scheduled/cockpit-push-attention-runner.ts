import type { Db } from "../../db/client.ts";
import { withTenantWork } from "../../execution/index.ts";
import { COCKPIT_PUSH_TENANT_PAGE, listCockpitPushTenants } from "../../identity/index.ts";
import { withIsolatedContext } from "../../logging/context.ts";
import { dispatchCockpitPushAttention } from "../cockpit-push-attention.ts";

export async function runCockpitPushAttention(
  db: Db,
  at: Date,
  dispatch: typeof dispatchCockpitPushAttention = dispatchCockpitPushAttention,
  pageSize = COCKPIT_PUSH_TENANT_PAGE,
): Promise<string[]> {
  const visitPage = async (after: string | null, visited: string[]): Promise<string[]> => {
    const tenantIds = await listCockpitPushTenants(db, at, { after, limit: pageSize });
    for (const tenantId of tenantIds)
      await withTenantWork(tenantId, () =>
        withIsolatedContext(
          { tenant_id: tenantId, request_source: "scheduler", actor_id: "scheduler" },
          () => dispatch(db, tenantId, { now: at }),
        ),
      );
    const next = [...visited, ...tenantIds];
    const last = tenantIds.at(-1);
    return tenantIds.length < pageSize || !last ? next : visitPage(last, next);
  };
  return visitPage(null, []);
}
