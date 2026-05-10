// Fork a conversation at a specific message id. Creates a new
// conversation row owned by the same actor + tenant, copies every
// message up to and including the anchor message into the new
// conversation, and returns the new conversation id.
//
// G10 closure of #159 M10. Tool calls and elicitations are NOT
// copied — they're tied to the message ids in the source conversation
// and re-running them in the fork would duplicate their side effects.
// The forked conversation IS seeded with the source's `draft`,
// `memory`, `model`, target_connector_id, target_workflow_id, and
// `loaded_skills` so the next turn lands in the same authoring state
// the operator was in when they pressed `t`. (The earlier "clean
// session" wording was wrong — W2 of PR #161 review.)
//
// Caveat: assistant messages whose content text references
// `tool_call_id` values from the source will keep those references
// even though the matching tool_call rows are not copied. The CLI
// renderer treats unknown tool_call_id refs as plain text, so the
// fork is still readable; it's flagged here for incident-reading
// audit consumers (S2 of PR #161 review).

import { and, asc, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import type { ConversationRecord } from "../types.ts";
import { rowToRecord } from "./shared.ts";

export interface ForkConversationParams {
  tenant_id: string;
  source_conversation_id: string;
  anchor_message_id: string;
  actor_id: string | null;
  /** Optional title override; defaults to "fork — <source>". */
  title?: string | null;
}

export interface ForkConversationResult {
  conversation: ConversationRecord;
  source_conversation_id: string;
  anchor_message_id: string;
  copied_message_count: number;
  /**
   * W3 of PR #161 review (round 4): true when the fork hit
   * `FORK_COPY_MESSAGE_CAP` and copied only the most-recent
   * `FORK_COPY_MESSAGE_CAP` messages up to the anchor instead of
   * every message from index 0. Surfaces a deliberate truncation
   * to operators + audit consumers. The fork is still functional
   * (the anchor message is always included) — older context is
   * dropped to bound storage / memory amplification.
   */
  truncated: boolean;
}

/**
 * W3 of PR #161 review (round 4): hard cap on messages copied per
 * fork operation. Without it, a multi-thousand-message conversation
 * fed into `/fork` linearly amplifies storage + memory: the SELECT
 * pulls every row, the INSERT writes every row, and a malicious
 * caller with `conversation:write` could repeatedly fork from
 * second-to-last to amplify storage indefinitely.
 *
 * 5,000 chosen as 5x the typical incident-mode authoring loop length
 * (~1,000 turns × ~3 rows/turn ≈ 3,000) — well above any realistic
 * working session, well below where the linear ops become noticeable.
 */
export const FORK_COPY_MESSAGE_CAP = 5_000;

export async function forkConversation(
  p: ForkConversationParams,
  exec: Db,
): Promise<ForkConversationResult | null> {
  // Look up the source conversation + ALL its messages in created_at
  // order. We resolve the anchor by id-match in the in-memory list
  // rather than by `lte(created_at, anchor.created_at)` because JS
  // Date is millisecond-precision but Postgres `timestamp with time
  // zone` is microsecond-precision — round-tripping the anchor's
  // timestamp through JS truncates to ms and then `lte` excludes the
  // anchor's own row whenever its µs portion is non-zero.
  const [source] = await exec
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.source_conversation_id)),
    );
  if (!source) return null;
  const allMessages = await exec
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, p.tenant_id),
        eq(conversationMessages.conversation_id, p.source_conversation_id),
      ),
    )
    .orderBy(asc(conversationMessages.created_at));
  const anchorIdx = allMessages.findIndex((m) => m.id === p.anchor_message_id);
  if (anchorIdx < 0) return null;

  // Copy the source row's connector + workflow + draft + memory + model +
  // loaded_skills verbatim. Status resets to "active". The fork inherits
  // the prior loaded-skills set so the next turn doesn't need a fresh
  // catalog probe; if downstream skills change, the loop re-derives.
  const forkTitle = p.title ?? `fork — ${source.title ?? source.id.slice(0, 8)}`;
  const [row] = await exec
    .insert(conversations)
    .values({
      tenant_id: p.tenant_id,
      target_connector_id: source.target_connector_id,
      target_workflow_id: source.target_workflow_id,
      status: "active",
      draft: source.draft,
      owner_id: p.actor_id ?? source.owner_id ?? null,
      loaded_skills: source.loaded_skills,
      title: forkTitle,
      memory: source.memory,
      ...(source.model ? { model: source.model } : {}),
    })
    .returning();
  assertInsertRow(row, "conversations");

  // Copy messages [0..anchorIdx] inclusive. Concurrent appends to the
  // source past the anchor are naturally excluded because they were
  // not in `allMessages` at fetch time (the SELECT happened before the
  // INSERT below — read-then-write semantics). New rows get fresh ids;
  // `created_at` is set to "now" so the fork's timeline orders cleanly.
  //
  // W3 of PR #161 review (round 4): clamp to FORK_COPY_MESSAGE_CAP to
  // bound storage amplification on long sessions. When the cap fires
  // we keep the most recent N messages up to and including the
  // anchor; older context is dropped. The anchor message is always
  // preserved (slice end is anchorIdx+1).
  const fullSlice = allMessages.slice(0, anchorIdx + 1);
  const truncated = fullSlice.length > FORK_COPY_MESSAGE_CAP;
  const messagesToCopy = truncated
    ? fullSlice.slice(fullSlice.length - FORK_COPY_MESSAGE_CAP)
    : fullSlice;
  let copiedCount = 0;
  if (messagesToCopy.length > 0) {
    await exec.insert(conversationMessages).values(
      messagesToCopy.map((m) => ({
        tenant_id: p.tenant_id,
        conversation_id: row.id,
        role: m.role,
        content: m.content,
        tokens_in: m.tokens_in,
        tokens_out: m.tokens_out,
      })),
    );
    copiedCount = messagesToCopy.length;
  }

  // S1 of PR #161 review round 2: log under `conversation.forked`
  // (not `created`) so structured-log readers can split forks from
  // greenfield creates the same way the audit row does.
  log.conversation.forked({
    conversation_id: row.id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    connector_id: source.target_connector_id ?? null,
    workflow_id: source.target_workflow_id ?? null,
    forked_from: p.source_conversation_id,
    anchor_message_id: p.anchor_message_id,
    copied_message_count: copiedCount,
    memory_included: Boolean(source.memory),
    truncated,
    source_message_count: fullSlice.length,
  });

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      // W1 of PR #161 review — distinct fork action for audit-log
      // incident readers. Metadata still records source + anchor +
      // count so the previous CONVERSATION_CREATED-style query path
      // can be reconstructed by joining on `forked_from`.
      action: AuditAction.CONVERSATION_FORKED,
      resource_type: "conversation",
      resource_id: row.id,
      result: "success",
      reason: `forked from ${p.source_conversation_id} at message ${p.anchor_message_id}`,
      metadata: {
        forked_from: p.source_conversation_id,
        anchor_message_id: p.anchor_message_id,
        copied_message_count: copiedCount,
        // S-1 of PR #161 review (round 3): make the deliberately
        // omitted side-effect rows self-describing on the audit row,
        // so an incident reader reconstructing state from `audit_log`
        // alone doesn't have to open the source comment to learn what
        // the fork did NOT carry over. The contract here is documented
        // both in the route description (`lifecycle.ts`) and in the
        // service-layer header above; the audit row is now the third
        // independent home for it.
        tool_calls_omitted: true,
        elicitations_omitted: true,
        // W3 of PR #161 review (round 4): record both the cap-hit
        // flag and the original count so audit-only incident readers
        // can detect a truncation event without joining back to the
        // source conversation.
        truncated,
        source_message_count: fullSlice.length,
        copy_cap: FORK_COPY_MESSAGE_CAP,
      },
    },
    exec,
  );

  return {
    conversation: rowToRecord(row),
    source_conversation_id: p.source_conversation_id,
    anchor_message_id: p.anchor_message_id,
    copied_message_count: copiedCount,
    truncated,
  };
}
