// Zombie reconciliation for time-bounded elicitations.
//
// The chat confirm gate mints a `tool_approvals` row (24-hour TTL, see
// `tools/approval.ts`), opens an `ask_user_confirm` elicitation carrying the
// approval handle, and parks the conversation in `awaiting_input`. When the
// operator never answers, the approval dies on its TTL — and the retention
// sweep (`tool-approvals-cleanup-runner.ts`) eventually deletes the row —
// but nothing ever resolved the elicitation or reactivated the conversation.
// The session strands forever: pending prompt, `awaiting_input` status, an
// MCP Tasks poll that keeps deriving `input_required` for a decision that can
// no longer be made.
//
// This sweep closes that gap for EVERY pending elicitation, selecting on the
// row's own `expires_at`. It used to re-derive each bounded kind from JSONB
// instead — approval handles and draft-credential grants only — so an ordinary
// `ask_user_*` prompt was never selectable and stranded permanently. Production
// carried 60 such conversations, the oldest for two and a half months.
//
// It is also not only an EXPIRY sweep. An approval-backed row is reconciled
// against `tool_approvals`, and a decision a human already made is CARRIED OUT
// rather than timed out — the edge whose absence let a granted approval reach a
// dead end and then be reported as "the operator did not answer". The portal
// route normally completes that in the human's own request; this is the backstop
// for a resume that was interrupted, since `conversation.run-turn` never retries.
//
// TENANT SCOPING: the SELECT is a global, cross-tenant sweep like the other
// retention runners, but every per-row action runs under the row's own
// tenant — the resolve, the conversation flip, and the ELICITATION_EXPIRED
// audit row all land tenant-scoped.
//
// ONE CLOCK: selection, approval liveness, and the expiry arithmetic all compare
// against Postgres' `now()`. The engine-supplied `started` instant is used only
// to label and time the tick.

import { and, asc, eq, lt, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import {
  type ApprovalResumeEnqueuer,
  completeApprovalBackedElicitation,
} from "../conversations/approval-completion.ts";
import { DRAFT_CREDENTIAL_SETUP_KIND } from "../conversations/draft-credential-setup.ts";
import {
  type ElicitationExpiryReason,
  expireElicitationAndReactivate,
} from "../conversations/elicitations.ts";
import { approvalHandleFromElicitationInput } from "../conversations/tools/ask-user/commit-intent.ts";
import type { Db } from "../db/client.ts";
import { conversationElicitations, toolApprovals } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

/** Per-sweep row cap. The population is bounded by how many confirm gates
 *  can go unanswered within one approval TTL, so a backlog beyond this only
 *  occurs after downtime — and drains over the next few sweeps. */
const ELICITATION_EXPIRY_BATCH = 200;

/** Move a pending prompt's expiry onto its approval's, so the sweep stops
 *  re-examining a row whose real clock lives on the approval. */
async function carryExpiryToApproval(
  row: { tenant_id: string; id: string },
  handle: string,
  db: Db,
): Promise<void> {
  await db
    .update(conversationElicitations)
    .set({
      expires_at: sql`(select ${toolApprovals.expires_at} from ${toolApprovals} where ${toolApprovals.tenant_id} = ${row.tenant_id} and ${toolApprovals.id} = ${handle})`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, row.tenant_id),
        eq(conversationElicitations.id, row.id),
        eq(conversationElicitations.status, "pending"),
      ),
    );
}

/** Commit-intent kinds whose resume CLAIMS the approval (`consumeApproval`)
 *  rather than re-dispatching the tool with a prior-approval marker.
 *
 *  Only these can leave a granted capability unused, so only these can be
 *  "abandoned". A shape-specific carrier mints its approval as the portal
 *  channel and the decision record; its handle is never consumed by design, and
 *  reporting that as a lost grant would cry wolf on every save. */
const CLAIMING_COMMIT_INTENTS: ReadonlySet<string> = new Set([
  "execute_confirmed_tool_call",
  "commit_held_workflow_writes",
]);

function claimsApproval(input: Record<string, unknown> | null): boolean {
  const intent = input?.commit_intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return false;
  const kind = (intent as { kind?: unknown }).kind;
  return typeof kind === "string" && CLAIMING_COMMIT_INTENTS.has(kind);
}

/** Which capability lapsed, so the note the model reads names the right thing. */
function expiryReasonFor(
  handle: string | null,
  input: Record<string, unknown> | null,
): ElicitationExpiryReason {
  if (handle) return "approval_expired";
  if (input?.kind === DRAFT_CREDENTIAL_SETUP_KIND) return "credential_setup_expired";
  return "prompt_expired";
}

/**
 * Run one reconciliation sweep over expired pending elicitations.
 *
 * The SELECT is now uniform: `status = 'pending'` and the row's own
 * `expires_at` has passed. Every row gets an `expires_at` at insert
 * (`elicitationExpiry`), so an ordinary `ask_user_*` prompt is bounded like
 * everything else. It previously was not: the selection re-derived each bounded
 * KIND from JSONB, which meant a plain question could never be selected at all,
 * and production accumulated 60 conversations wedged in `awaiting_input` — the
 * oldest for two and a half months — each still deriving `input_required` on
 * every MCP Tasks poll.
 *
 * Approval-backed rows are then reconciled against `tool_approvals`, because the
 * elicitation's clock is not the authority for them:
 *   - granted and unclaimed → COMPLETE it. This edge did not exist; the sweep
 *     only ever expired, so a human's yes could reach a dead end and then be
 *     reported as "the operator did not answer".
 *   - declined → resolve as a decline, not a timeout.
 *   - still claimable → leave it, and push the elicitation's own expiry out to
 *     the approval's so the next tick does not re-examine it.
 */
export async function runElicitationExpiry(
  started: Date,
  db: Db,
  deps?: { resume?: ApprovalResumeEnqueuer },
): Promise<void> {
  const tickId = started.toISOString();
  let expired_count = 0;
  let completed_count = 0;

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
          lt(conversationElicitations.expires_at, sql`now()`),
        ),
      )
      .orderBy(asc(conversationElicitations.expires_at))
      .limit(ELICITATION_EXPIRY_BATCH);

    for (const row of rows) {
      const input =
        row.input && typeof row.input === "object" && !Array.isArray(row.input)
          ? (row.input as Record<string, unknown>)
          : null;
      // Canonical extraction — same reader the resume dispatcher uses, so a
      // malformed handle (e.g. an empty string) is treated as absent rather than
      // queried as if it were an approval id.
      const handle = approvalHandleFromElicitationInput(row.input);
      // Per-row try/catch: one poisoned row (e.g. a handle that is not a uuid)
      // must not abort the rest of the sweep.
      try {
        if (handle) {
          const [approval] = await db
            .select({
              live: sql<boolean>`${toolApprovals.expires_at} > now()`,
              granted: sql<boolean>`${toolApprovals.granted_at} is not null`,
              declined: sql<boolean>`${toolApprovals.declined_at} is not null`,
              consumed: sql<boolean>`${toolApprovals.consumed_at} is not null`,
            })
            .from(toolApprovals)
            .where(and(eq(toolApprovals.tenant_id, row.tenant_id), eq(toolApprovals.id, handle)))
            .limit(1);

          // A person said yes and the write never ran. The primary path (the
          // portal route, in the human's own request) normally completes this
          // within seconds; reaching here means that path was interrupted — an
          // engine restart between the grant and the enqueue, or a lost job.
          // `conversation.run-turn` has `retryLimit: 0`, so without this edge the
          // decision is simply lost.
          if (approval?.granted && !approval.declined && !approval.consumed) {
            const resume = deps?.resume;
            if (approval.live && resume) {
              const completion = await completeApprovalBackedElicitation(
                {
                  tenant_id: row.tenant_id,
                  approval_id: handle,
                  decision: "approve",
                  // The grant already recorded who approved; the sweep is not a
                  // person and must not name one.
                  approver_user_id: null,
                  resume,
                },
                db,
              );
              if (completion.resumed > 0) {
                completed_count += 1;
                // The row stays `pending` until the resumed turn resolves it, so
                // carry its expiry to the end of the claim window. Without this
                // the next tick would select it again and enqueue a SECOND
                // resume while the first is still running; once the window does
                // close, the grant-abandoned branch above correctly claims it.
                await carryExpiryToApproval(row, handle, db);
                continue;
              }
            }
            // The claim window closed (or there is no resume channel) — the
            // decision cannot be acted on any more. Expire it, but say so
            // loudly: every other trace of this outcome looks identical to
            // "nobody answered".
            //
            // Only for carriers that actually claim. A shape-specific carrier's
            // handle is the portal channel, not a capability the resume spends,
            // so an unconsumed one is the normal end state — not a lost grant.
            if (!claimsApproval(input)) {
              const resolution = await expireElicitationAndReactivate(
                {
                  tenant_id: row.tenant_id,
                  conversation_id: row.conversation_id,
                  id: row.id,
                  reason: "approval_expired",
                },
                db,
              );
              if (resolution.kind === "resolved") expired_count += 1;
              continue;
            }
            await auditAwait(
              {
                tenant_id: row.tenant_id,
                actor_type: "system",
                actor_id: null,
                action: AuditAction.APPROVAL_GRANT_ABANDONED,
                resource_type: "tool_approval",
                resource_id: handle,
                result: "success",
                reason: approval.live ? "no_resume_channel" : "claim_window_closed",
                metadata: {
                  conversation_id: row.conversation_id,
                  elicitation_id: row.id,
                },
              },
              db,
            );
            logger.warn({
              module: "scheduler",
              action: "elicitation_expiry.grant_abandoned",
              msg: "a human granted this approval and it was never claimed; the approved call will not run",
              tick_id: tickId,
              tenant_id: row.tenant_id,
              conversation_id: row.conversation_id,
              elicitation_id: row.id,
              approval_id: handle,
              claim_window_open: approval.live === true,
            });
            // Tell the model the truth: the person said yes and we were late.
            const abandoned = await expireElicitationAndReactivate(
              {
                tenant_id: row.tenant_id,
                conversation_id: row.conversation_id,
                id: row.id,
                reason: "approval_abandoned",
              },
              db,
            );
            if (abandoned.kind === "resolved") expired_count += 1;
            continue;
          } else if (approval?.live) {
            // Still answerable. The approval's clock — not the elicitation's —
            // is the authority here, so carry the prompt forward with it instead
            // of re-examining this row on every tick.
            await carryExpiryToApproval(row, handle, db);
            continue;
          }
        }

        const resolution = await expireElicitationAndReactivate(
          {
            tenant_id: row.tenant_id,
            conversation_id: row.conversation_id,
            id: row.id,
            reason: expiryReasonFor(handle, input),
          },
          db,
        );
        if (resolution.kind === "resolved") expired_count += 1;
      } catch (err) {
        logger.error({
          module: "scheduler",
          action: "elicitation_expiry.row_failed",
          msg: "reconciling an expired elicitation failed",
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
    msg: "time-bounded elicitation expiry sweep completed",
    tick_id: tickId,
    expired_count,
    completed_count,
    duration_ms: Date.now() - started.getTime(),
  });
}
