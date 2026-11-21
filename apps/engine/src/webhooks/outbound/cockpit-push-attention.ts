import type { Db } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/index.ts";
import { dispatchCockpitPushAttention } from "../../notifications/cockpit-push-attention.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import { classifyEvent } from "../events/catalog.ts";

export function shouldDispatchCockpitPushAttention(eventType: string, payload: unknown): boolean {
  return classifyEvent(eventType, payload).actionable;
}

export function triggerCockpitPushAttention(
  db: Db,
  tenantId: string,
  dispatch: typeof dispatchCockpitPushAttention = dispatchCockpitPushAttention,
): Promise<void> {
  invalidateAttention(tenantId);
  return Promise.resolve()
    .then(() => dispatch(db, tenantId))
    .then(
      () => undefined,
      (error: unknown) => {
        logger.warn({
          module: "webhooks.outbound",
          action: "cockpit_push.trigger_failed",
          msg: "cockpit push attention trigger failed",
          tenant_id: tenantId,
          ...errorFields(error),
        });
      },
    );
}
