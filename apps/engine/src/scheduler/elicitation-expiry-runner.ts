// Zombie reconciliation for approval-backed elicitations.
//
// The chat confirm gate mints a `tool_approvals` row (15-minute TTL, see
// `tools/approval.ts`), opens an `ask_user_confirm` elicitation carrying the
// approval handle, and parks the conversation in `awaiting_input`. When the
// operator never answers, the approval dies on its TTL — and the retention
// sweep (`tool-approvals-cleanup-runner.ts`) eventually deletes the row —
// but nothing ever resolved the elicitation or reactivated the conversation.
// The session strands forever: pending prompt, `awaiting_input` status, an
// MCP Tasks poll that keeps deriving `input_required` for a decision that can
// no longer be made.
//
// This sweep closes that gap. It walks pending elicitations old enough to
// have outlived the approval TTL whose input carries an approval handle,
// checks the handle against `tool_approvals`, and — when the approval row is
// ABSENT or past `expires_at`, regardless of granted/declined state (an
// unclaimed grant dies on the same TTL) — expires the elicitation and
// reactivates its conversation via `expireElicitationAndReactivate`. Rows
// whose approval is still live are untouched: the operator may yet answer.
//
// TENANT SCOPING: the SELECT is a global, cross-tenant sweep like the other
// retention runners, but every per-row action runs under the row's own
// tenant — the resolve, the conversation flip, and the ELICITATION_EXPIRED
// audit row all land tenant-scoped.
//
// ONE CLOCK: the age prefilter and the approval-liveness check both compare
// against Postgres' `now()`, the same clock `expires_at` was written with.
// The app clock never participates.

import { and, asc, eq, lt, sql } from "drizzle-orm";
import { expireElicitationAndReactivate } from "../conversations/elicitations.ts";
import {
  APPROVAL_HANDLE_KEY,
  approvalHandleFromElicitationInput,
} from "../conversations/tools/ask-user/commit-intent.ts";
import type { Db } from "../db/client.ts";
import { conversationElicitations, toolApprovals } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { APPROVAL_TTL_MS } from "../tools/approval.ts";

/** Per-sweep row cap. The population is bounded by how many confirm gates
 *  can go unanswered within one approval TTL, so a backlog beyond this only
 *  occurs after downtime — and drains over the next few sweeps. */
const ELICITATION_EXPIRY_BATCH = 200;

/**
 * Run one expiry sweep over approval-backed pending elicitations.
 *
 * The SELECT prefilters in SQL — `status = 'pending'`, older than the
 * approval TTL, and `input->'commit_intent'->'payload'` carries an
 * `approval_id` key — so the scan never touches ordinary `ask_user_*`
 * prompts, which have no TTL and may legitimately wait on a human for days.
 */
export async function runElicitationExpiry(started: Date, db: Db): Promise<void> {
  const tickId = started.toISOString();
  let expired_count = 0;

  try {
    // tenant-filter:exempt — cross-tenant reconciliation sweep; every per-row
    // write below is scoped to the row's own tenant.
    const rows = await db
      .select({
        id: conversationElicitations.id,
        tenant_id: conversationElicitations.tenant_id,
        conversation_id: conversationElicitations.conversation_id,
        input: conversationElicitations.input,
      })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.status, "pending"),
          lt(
            conversationElicitations.created_at,
            sql`now() - make_interval(secs => ${APPROVAL_TTL_MS / 1000})`,
          ),
          // `jsonb_exists` is the function form of the jsonb `?` operator —
          // used here so the key check stays a parameterizable expression.
          sql`jsonb_exists(${conversationElicitations.input} -> 'commit_intent' -> 'payload', ${APPROVAL_HANDLE_KEY})`,
        ),
      )
      .orderBy(asc(conversationElicitations.created_at))
      .limit(ELICITATION_EXPIRY_BATCH);

    for (const row of rows) {
      // Canonical extraction — same reader the resume dispatcher uses, so a
      // prefilter false-positive (e.g. an empty-string handle) is skipped
      // rather than treated as an absent approval.
      const handle = approvalHandleFromElicitationInput(row.input);
      if (!handle) continue;
      // Per-row try/catch: one poisoned row (e.g. a malformed handle that is
      // not a uuid) must not abort the rest of the sweep.
      try {
        const [approval] = await db
          .select({ live: sql<boolean>`${toolApprovals.expires_at} > now()` })
          .from(toolApprovals)
          .where(and(eq(toolApprovals.tenant_id, row.tenant_id), eq(toolApprovals.id, handle)))
          .limit(1);
        // Still claimable (or grantable) — the operator may yet answer.
        if (approval?.live) continue;
        const resolution = await expireElicitationAndReactivate(
          { tenant_id: row.tenant_id, conversation_id: row.conversation_id, id: row.id },
          db,
        );
        if (resolution.kind === "resolved") expired_count += 1;
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "elicitation_expiry.row_failed",
          msg: "expiring approval-backed elicitation failed",
          tick_id: tickId,
          tenant_id: row.tenant_id,
          conversation_id: row.conversation_id,
          elicitation_id: row.id,
          ...errorFields(err),
        });
      }
    }
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "elicitation_expiry.select_failed",
      msg: "elicitation expiry sweep select failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // Log every run (even 0), symmetric with the tool_approvals sweep, so an
  // operator scanning structured logs can prove the sweep is alive.
  logger.info({
    module: "scheduler",
    action: "elicitation_expiry.fired",
    msg: "approval-backed elicitation expiry sweep completed",
    tick_id: tickId,
    expired_count,
    duration_ms: Date.now() - started.getTime(),
  });
}
