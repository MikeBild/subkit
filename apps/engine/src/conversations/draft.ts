// Draft document CRUD + snapshot history.
//
// Every mutation (`propose_step`, `update_param`, `connect_steps`)
// writes a new row into `conversation_drafts` with an incrementing
// ordinal. The newest ordinal is the live draft; :undo pops the top.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationDrafts, conversations } from "../db/schema/index.ts";
import type { DraftDocument } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function emptyDraft(): DraftDocument {
  return { name: "new-workflow", steps: [] };
}

function padOrdinal(n: number): string {
  return n.toString().padStart(6, "0");
}

/**
 * Load the live draft for a conversation. Returns a fresh empty
 * document if none exists yet.
 */
export async function loadDraft(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
): Promise<DraftDocument> {
  const rows = await exec
    .select()
    .from(conversationDrafts)
    .where(
      and(
        eq(conversationDrafts.tenant_id, tenant_id),
        eq(conversationDrafts.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationDrafts.ordinal))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // Fall back to the `conversations.draft` column in case a caller
    // seeded it via the service.
    const convRows = await exec
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation_id))
      .limit(1);
    const draft = convRows[0]?.draft;
    if (draft && typeof draft === "object") {
      return draft as DraftDocument;
    }
    return emptyDraft();
  }
  return row.snapshot as DraftDocument;
}

/**
 * Append a new snapshot. `mutate` receives the current draft and
 * returns the new one — mutating in place is fine because we clone
 * the argument first.
 */
export async function appendSnapshot(
  tenant_id: string,
  conversation_id: string,
  draft: DraftDocument,
  exec: Executor,
): Promise<void> {
  // Ordinal is monotonic — compute as count + 1 over the live set.
  const [row] = (await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(conversationDrafts)
    .where(eq(conversationDrafts.conversation_id, conversation_id))) as Array<{ n: number }>;
  const next = (row?.n ?? 0) + 1;
  await exec.insert(conversationDrafts).values({
    tenant_id,
    conversation_id,
    ordinal: padOrdinal(next),
    snapshot: draft as unknown as Record<string, unknown>,
  });
  // Mirror to conversations.draft for easy reads.
  await exec
    .update(conversations)
    .set({ draft: draft as unknown as Record<string, unknown>, updated_at: new Date() })
    .where(eq(conversations.id, conversation_id));
}

/**
 * Pop the most recent snapshot, restoring the previous one. Returns
 * the now-current draft (or the empty draft if the history is empty).
 */
export async function undoLastSnapshot(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
): Promise<DraftDocument> {
  const rows = await exec
    .select()
    .from(conversationDrafts)
    .where(
      and(
        eq(conversationDrafts.tenant_id, tenant_id),
        eq(conversationDrafts.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationDrafts.ordinal));
  if (rows.length === 0) return emptyDraft();
  const head = rows[0];
  if (!head) return emptyDraft();
  await exec.delete(conversationDrafts).where(eq(conversationDrafts.id, head.id));
  const next = rows[1];
  const draft = (next?.snapshot as DraftDocument | undefined) ?? emptyDraft();
  await exec
    .update(conversations)
    .set({ draft: draft as unknown as Record<string, unknown>, updated_at: new Date() })
    .where(eq(conversations.id, conversation_id));
  return draft;
}
