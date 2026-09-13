import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { conversationElicitations } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

type CompletionNotifier = () => Promise<void>;

interface RegisteredCompletionNotifier {
  notify: CompletionNotifier;
  expires_at: number;
  expiry_timer: ReturnType<typeof setTimeout>;
}

const completionNotifiers = new Map<string, RegisteredCompletionNotifier>();

async function notifyCompletion(
  rows: Array<{ id: string }>,
  context: { tenant_id: string; connector_id?: string; conversation_id?: string },
): Promise<void> {
  for (const row of rows) {
    const registered = completionNotifiers.get(row.id);
    if (!registered) continue;
    clearTimeout(registered.expiry_timer);
    completionNotifiers.delete(row.id);
    if (registered.expires_at < Date.now()) continue;
    try {
      await registered.notify();
    } catch (err) {
      logger.warn({
        module: "conversation",
        action: "elicitation.url_completion_notification_failed",
        msg: "external URL elicitation completed but its MCP notification failed",
        tenant_id: context.tenant_id,
        ...(context.connector_id ? { connector_id: context.connector_id } : {}),
        ...(context.conversation_id ? { conversation_id: context.conversation_id } : {}),
        elicitation_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function registerNativeUrlElicitationCompletion(
  elicitationId: string,
  notify: CompletionNotifier,
): () => void {
  const previous = completionNotifiers.get(elicitationId);
  if (previous) clearTimeout(previous.expiry_timer);

  const registered: RegisteredCompletionNotifier = {
    notify,
    expires_at: Date.now() + 10 * 60_000,
    expiry_timer: setTimeout(() => {
      if (completionNotifiers.get(elicitationId) === registered) {
        completionNotifiers.delete(elicitationId);
      }
    }, 10 * 60_000),
  };
  registered.expiry_timer.unref();
  completionNotifiers.set(elicitationId, registered);

  return () => {
    if (completionNotifiers.get(elicitationId) !== registered) return;
    clearTimeout(registered.expiry_timer);
    completionNotifiers.delete(elicitationId);
  };
}

export async function markConnectorNativeUrlElicitationsComplete(
  p: {
    tenant_id: string;
    connector_id: string;
    outcome: "succeeded" | "failed";
  },
  db: Db,
): Promise<number> {
  const rows = await db
    .update(conversationElicitations)
    .set({
      delivery_lease_id: null,
      delivery_lease_expires_at: null,
      delivery_last_error: p.outcome === "succeeded" ? "url_completed" : "url_failed",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.status, "pending"),
        sql`${conversationElicitations.input}->>'connector_id' = ${p.connector_id}`,
        sql`${conversationElicitations.input} ?| array['authorization_url', 'setup_url']`,
      ),
    )
    .returning({ id: conversationElicitations.id });

  await notifyCompletion(rows, { tenant_id: p.tenant_id, connector_id: p.connector_id });

  return rows.length;
}

/**
 * Stamp the conversation elicitation paired with a policy-confirmation approval
 * a human decided through the out-of-band approval portal.
 *
 * This marks the row as settled (`url_completed` / `url_failed`) and nudges any
 * polling MCP client, so a client that polls before the resume job runs replays
 * the settled interaction itself (`conversation-native-elicitation.ts` replay
 * arm). It does NOT resolve the row or resume the turn — that is
 * `completeApprovalBackedElicitation`, which the portal route drives durably in
 * the human's own request. Both are safe together: `resolveElicitation` is a CAS
 * and `consumeApproval` is single-use, so whichever path arrives second is a
 * no-op rather than a second execution.
 *
 * `approve` maps to `succeeded` (accept) and `decline` to `failed` (cancel).
 *
 * Matched by the `approval_id` in `commit_intent` ALONE. It previously also
 * required an `approval_url` in the input, which silently excluded every confirm
 * row whose gate minted a link it never persisted (`external-mcp-tools.ts`,
 * `synthetic-workflow-tools.ts`) — in production 4 of 5 approval-backed rows,
 * for which this bridge therefore matched nothing at all. The approval handle is
 * the relation; the URL is only one of the channels that can carry the decision.
 */
export async function markApprovalElicitationsComplete(
  p: {
    tenant_id: string;
    approval_id: string;
    outcome: "succeeded" | "failed";
  },
  db: Db,
): Promise<Array<{ id: string; conversation_id: string }>> {
  const rows = await db
    .update(conversationElicitations)
    .set({
      delivery_lease_id: null,
      delivery_lease_expires_at: null,
      delivery_last_error: p.outcome === "succeeded" ? "url_completed" : "url_failed",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.status, "pending"),
        sql`${conversationElicitations.input}->'commit_intent'->'payload'->>'approval_id' = ${p.approval_id}`,
      ),
    )
    .returning({
      id: conversationElicitations.id,
      conversation_id: conversationElicitations.conversation_id,
    });

  await notifyCompletion(rows, { tenant_id: p.tenant_id });

  return rows;
}

export async function claimDraftCredentialNativeUrlElicitation(
  p: { tenant_id: string; conversation_id: string; elicitation_id: string },
  db: Db,
): Promise<boolean> {
  const rows = await db
    .update(conversationElicitations)
    .set({
      delivery_lease_id: null,
      delivery_lease_expires_at: null,
      delivery_last_error: "url_credential_claimed",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.id, p.elicitation_id),
        eq(conversationElicitations.status, "pending"),
        sql`coalesce(${conversationElicitations.delivery_last_error}, '') not in ('url_credential_claimed', 'url_completed', 'url_failed')`,
      ),
    )
    .returning({ id: conversationElicitations.id });
  return rows.length === 1;
}

export async function completeDraftCredentialNativeUrlElicitation(
  p: { tenant_id: string; conversation_id: string; elicitation_id: string },
  db: Db,
): Promise<boolean> {
  const rows = await db
    .update(conversationElicitations)
    .set({
      delivery_last_error: "url_completed",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.id, p.elicitation_id),
        eq(conversationElicitations.status, "pending"),
        eq(conversationElicitations.delivery_last_error, "url_credential_claimed"),
      ),
    )
    .returning({ id: conversationElicitations.id });
  await notifyCompletion(rows, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
  });
  return rows.length === 1;
}

export async function releaseDraftCredentialNativeUrlElicitation(
  p: { tenant_id: string; conversation_id: string; elicitation_id: string },
  db: Db,
): Promise<void> {
  await db
    .update(conversationElicitations)
    .set({
      delivery_last_error: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.id, p.elicitation_id),
        eq(conversationElicitations.status, "pending"),
        eq(conversationElicitations.delivery_last_error, "url_credential_claimed"),
      ),
    );
}
