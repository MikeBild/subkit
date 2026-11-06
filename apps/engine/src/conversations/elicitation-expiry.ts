import { and, asc, eq, lt, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { conversationElicitations, toolApprovals } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import {
  type ApprovalResumeEnqueuer,
  completeApprovalBackedElicitation,
} from "./approval-completion.ts";
import { DRAFT_CREDENTIAL_SETUP_KIND } from "./draft-credential-setup.ts";
import { type ElicitationExpiryReason, expireElicitationAndReactivate } from "./elicitations.ts";
import { approvalHandleFromElicitationInput } from "./tools/ask-user/commit-intent.ts";

export interface ElicitationExpiryTally {
  expired_count: number;
  completed_count: number;
}

export interface ElicitationExpiryDeps {
  resume?: ApprovalResumeEnqueuer;
}

const ELICITATION_EXPIRY_BATCH = 200;

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

function expiryReasonFor(
  handle: string | null,
  input: Record<string, unknown> | null,
): ElicitationExpiryReason {
  if (handle) return "approval_expired";
  if (input?.kind === DRAFT_CREDENTIAL_SETUP_KIND) return "credential_setup_expired";
  return "prompt_expired";
}

export async function expireDueElicitations(
  tally: ElicitationExpiryTally,
  tickId: string,
  db: Db,
  deps?: ElicitationExpiryDeps,
): Promise<void> {
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
    const handle = approvalHandleFromElicitationInput(row.input);
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

        if (approval?.granted && !approval.declined && !approval.consumed) {
          const resume = deps?.resume;
          if (approval.live && resume) {
            const completion = await completeApprovalBackedElicitation(
              {
                tenant_id: row.tenant_id,
                approval_id: handle,
                decision: "approve",
                approver_user_id: null,
                resume,
              },
              db,
            );
            if (completion.resumed > 0) {
              tally.completed_count += 1;
              await carryExpiryToApproval(row, handle, db);
              continue;
            }
          }
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
            if (resolution.kind === "resolved") tally.expired_count += 1;
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
          const abandoned = await expireElicitationAndReactivate(
            {
              tenant_id: row.tenant_id,
              conversation_id: row.conversation_id,
              id: row.id,
              reason: "approval_abandoned",
            },
            db,
          );
          if (abandoned.kind === "resolved") tally.expired_count += 1;
          continue;
        } else if (approval?.live) {
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
      if (resolution.kind === "resolved") tally.expired_count += 1;
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
}
