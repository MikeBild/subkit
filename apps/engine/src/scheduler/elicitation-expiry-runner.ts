import {
  type ElicitationExpiryDeps,
  type ElicitationExpiryTally,
  expireDueElicitations,
} from "../conversations/public/elicitation.ts";
import type { Db } from "../db/client.ts";
import { errorFields, logger } from "../logging/logger.ts";

export async function runElicitationExpiry(
  started: Date,
  db: Db,
  deps?: ElicitationExpiryDeps,
): Promise<void> {
  const tickId = started.toISOString();
  const tally: ElicitationExpiryTally = { expired_count: 0, completed_count: 0 };

  try {
    await expireDueElicitations(tally, tickId, db, deps);
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "elicitation_expiry.select_failed",
      msg: "elicitation expiry sweep select failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  logger.info({
    module: "scheduler",
    action: "elicitation_expiry.fired",
    msg: "time-bounded elicitation expiry sweep completed",
    tick_id: tickId,
    expired_count: tally.expired_count,
    completed_count: tally.completed_count,
    duration_ms: Date.now() - started.getTime(),
  });
}
