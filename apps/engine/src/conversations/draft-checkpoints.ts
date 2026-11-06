import { and, count, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationDraftSnapshots } from "../db/schema/index.ts";
import type { DraftDocument } from "./types.ts";

const MAX_SNAPSHOTS_PER_CONVERSATION = 10;

interface DraftSnapshot {
  id: string;
  conversation_id: string;
  tenant_id: string;
  turn_index: number;
  draft: DraftDocument;
  label: string | null;
  snapshot_at: string;
}

interface SnapshotCreateParams {
  tenant_id: string;
  conversation_id: string;
  turn_index: number;
  draft: DraftDocument;
  label?: string | null;
}

export async function createDraftSnapshot(
  p: SnapshotCreateParams,
  exec: Db,
): Promise<DraftSnapshot> {
  const [row] = await exec
    .insert(conversationDraftSnapshots)
    .values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      turn_index: p.turn_index,
      draft: p.draft as unknown as Record<string, unknown>,
      label: p.label ?? null,
    })
    .returning();
  if (!row) throw new Error("draft snapshot insert returned no row");

  const all = await exec
    .select({ id: conversationDraftSnapshots.id })
    .from(conversationDraftSnapshots)
    .where(
      and(
        eq(conversationDraftSnapshots.tenant_id, p.tenant_id),
        eq(conversationDraftSnapshots.conversation_id, p.conversation_id),
      ),
    )
    .orderBy(desc(conversationDraftSnapshots.snapshot_at));
  if (all.length > MAX_SNAPSHOTS_PER_CONVERSATION) {
    const doomed = all.slice(MAX_SNAPSHOTS_PER_CONVERSATION).map((r) => r.id);
    for (const id of doomed) {
      await exec.delete(conversationDraftSnapshots).where(eq(conversationDraftSnapshots.id, id));
    }
  }

  return {
    id: row.id,
    conversation_id: row.conversation_id,
    tenant_id: row.tenant_id,
    turn_index: row.turn_index,
    draft: row.draft as unknown as DraftDocument,
    label: row.label ?? null,
    snapshot_at: row.snapshot_at.toISOString(),
  };
}

export async function listDraftSnapshots(
  p: { tenant_id: string; conversation_id: string; limit?: number },
  exec: Db,
): Promise<DraftSnapshot[]> {
  const limit = Math.min(Math.max(1, p.limit ?? MAX_SNAPSHOTS_PER_CONVERSATION), 50);
  const rows = await exec
    .select()
    .from(conversationDraftSnapshots)
    .where(
      and(
        eq(conversationDraftSnapshots.tenant_id, p.tenant_id),
        eq(conversationDraftSnapshots.conversation_id, p.conversation_id),
      ),
    )
    .orderBy(desc(conversationDraftSnapshots.snapshot_at))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    conversation_id: r.conversation_id,
    tenant_id: r.tenant_id,
    turn_index: r.turn_index,
    draft: r.draft as unknown as DraftDocument,
    label: r.label ?? null,
    snapshot_at: r.snapshot_at.toISOString(),
  }));
}

export async function getDraftSnapshot(
  p: { tenant_id: string; snapshot_id: string },
  exec: Db,
): Promise<DraftSnapshot | null> {
  const [row] = await exec
    .select()
    .from(conversationDraftSnapshots)
    .where(
      and(
        eq(conversationDraftSnapshots.tenant_id, p.tenant_id),
        eq(conversationDraftSnapshots.id, p.snapshot_id),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    tenant_id: row.tenant_id,
    turn_index: row.turn_index,
    draft: row.draft as unknown as DraftDocument,
    label: row.label ?? null,
    snapshot_at: row.snapshot_at.toISOString(),
  };
}

export async function countDraftSnapshots(
  p: { tenant_id: string; conversation_id: string },
  exec: Db,
): Promise<number> {
  const [row] = await exec
    .select({ c: count() })
    .from(conversationDraftSnapshots)
    .where(
      and(
        eq(conversationDraftSnapshots.tenant_id, p.tenant_id),
        eq(conversationDraftSnapshots.conversation_id, p.conversation_id),
      ),
    );
  return Number(row?.c ?? 0);
}

export const DRAFT_SNAPSHOT_LRU_CAP = MAX_SNAPSHOTS_PER_CONVERSATION;
