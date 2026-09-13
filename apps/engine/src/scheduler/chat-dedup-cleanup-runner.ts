// Retention sweep for `chat_events_seen`.
//
// Slack retries arrive within minutes (Slack's stated cap is 3 retries
// over a few minutes); anything older than ~24h is unreachable replay
// surface. Without pruning the table grows monotonically — at e.g. 1
// Slack message/sec across all installed workspaces, that's ~86k rows
// per day per engine. The DELETE filters by `seen_at < now() -
// interval`, so multi-instance overlap is a no-op (the second
// instance's sweep finds nothing fresh to delete).
//
// Mirrors `mcp-oauth-cleanup-runner.ts` and `files-cleanup-runner.ts`:
// one summary audit row under SYSTEM_TENANT_ID after the sweep, errors
// caught + logged but never abort the rest of the reconciler tick.

import { lt, sql } from "drizzle-orm";

import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { chatEventsSeen } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

/** Grace window for replay protection. 24 h is well past Slack's
 *  documented retry window (~5 attempts in a few minutes) and gives
 *  any operator inspecting recent dedup behavior a working sample
 *  before rows disappear. */
const REPLAY_GRACE = sql`interval '24 hours'`;

export async function runChatDedupCleanup(now: Date, db: Db): Promise<void> {
  const started = Date.now();
  let deleted: number;
  try {
    const result = await db
      .delete(chatEventsSeen)
      .where(lt(chatEventsSeen.seen_at, sql`${now.toISOString()}::timestamptz - ${REPLAY_GRACE}`))
      .returning({ platform_event_id: chatEventsSeen.platform_event_id });
    deleted = result.length;
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "chat_dedup_cleanup.sweep_failed",
      msg: "chat_events_seen retention sweep failed",
      ...errorFields(err),
    });
    return;
  }

  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CHAT_DEDUP_PRUNED,
      resource_type: "chat_events_seen",
      resource_id: null,
      result: "success",
      metadata: {
        sweep: "chat_events_seen",
        deleted,
        duration_ms: Date.now() - started,
      },
    },
    db,
  );
  // Log every run (even deleted=0), symmetric with files-cleanup
  // (`files_cleanup.fired`) and mcp-oauth-cleanup so an operator scanning
  // structured logs sees the hourly sweep regardless of whether it pruned
  // rows — not just on the rare non-empty sweep.
  logger.info({
    module: "scheduler",
    action: "chat_dedup_cleanup.completed",
    msg: "chat_events_seen retention sweep completed",
    deleted,
    duration_ms: Date.now() - started,
  });
}
