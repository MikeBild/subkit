import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  conversations,
  type Executor,
  type PersonalNoteArchiveReason,
  personalNoteSources,
  personalNotes,
} from "../../db/index.ts";
import type { NoteOwnerScope } from "../sealing.ts";

export type NoteRow = typeof personalNotes.$inferSelect;
export type NoteInsert = typeof personalNotes.$inferInsert;
export type NoteSourceRow = typeof personalNoteSources.$inferSelect;
export type NoteSourceInsert = typeof personalNoteSources.$inferInsert;

export interface NoteSourceWithChannel extends NoteSourceRow {
  readonly channel: string | null;
}

function owned(owner: NoteOwnerScope) {
  return and(
    eq(personalNotes.tenant_id, owner.tenant_id),
    eq(personalNotes.user_id, owner.user_id),
  );
}

export async function listNoteRows(
  db: Executor,
  owner: NoteOwnerScope,
  scope: "active" | "archived" | "all",
): Promise<NoteRow[]> {
  return db
    .select()
    .from(personalNotes)
    .where(
      and(
        owned(owner),
        scope === "all"
          ? undefined
          : scope === "active"
            ? isNull(personalNotes.archived_at)
            : isNotNull(personalNotes.archived_at),
      ),
    )
    .orderBy(desc(personalNotes.updated_at), personalNotes.id);
}

export async function findNoteRow(
  db: Executor,
  owner: NoteOwnerScope,
  id: string,
  lock = false,
): Promise<NoteRow | undefined> {
  const query = db
    .select()
    .from(personalNotes)
    .where(and(owned(owner), eq(personalNotes.id, id)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

export async function findActiveByAddress(
  db: Executor,
  owner: NoteOwnerScope,
  area: string,
  slug: string,
): Promise<NoteRow | undefined> {
  const [row] = await db
    .select()
    .from(personalNotes)
    .where(
      and(
        owned(owner),
        sql`${personalNotes.area} = ${area}`,
        eq(personalNotes.slug, slug),
        isNull(personalNotes.archived_at),
      ),
    )
    .limit(1);
  return row;
}

export async function countActiveNotes(db: Executor, owner: NoteOwnerScope): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(personalNotes)
    .where(and(owned(owner), isNull(personalNotes.archived_at)));
  return row?.count ?? 0;
}

export async function lockOwner(db: Executor, owner: NoteOwnerScope): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`personal_notes:${owner.tenant_id}:${owner.user_id}`}, 0))`,
  );
}

export async function listSourceRows(
  db: Executor,
  owner: NoteOwnerScope,
  note_ids: readonly string[],
): Promise<NoteSourceWithChannel[]> {
  if (note_ids.length === 0) return [];
  const rows = await db
    .select({ source: personalNoteSources, channel: conversations.surface })
    .from(personalNoteSources)
    .innerJoin(
      personalNotes,
      and(
        eq(personalNotes.id, personalNoteSources.note_id),
        eq(personalNotes.tenant_id, personalNoteSources.tenant_id),
      ),
    )
    .leftJoin(
      conversations,
      and(
        eq(conversations.id, personalNoteSources.conversation_id),
        eq(conversations.tenant_id, personalNoteSources.tenant_id),
      ),
    )
    .where(
      and(
        eq(personalNoteSources.tenant_id, owner.tenant_id),
        owned(owner),
        inArray(personalNoteSources.note_id, [...note_ids]),
      ),
    )
    .orderBy(personalNoteSources.created_at, personalNoteSources.id);
  return rows.map((row) => ({ ...row.source, channel: row.channel }));
}

export async function insertNoteRow(db: Executor, values: NoteInsert): Promise<NoteRow> {
  const [row] = await db.insert(personalNotes).values(values).returning();
  if (!row) throw new Error("personal note insertion failed");
  return row;
}

export async function insertSourceRow(db: Executor, values: NoteSourceInsert): Promise<boolean> {
  const inserted = await db
    .insert(personalNoteSources)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: personalNoteSources.id });
  return inserted.length > 0;
}

export async function archiveNoteRow(
  db: Executor,
  owner: NoteOwnerScope,
  p: {
    id: string;
    expected_version: number;
    reason: PersonalNoteArchiveReason;
    at: Date;
  },
): Promise<boolean> {
  const updated = await db
    .update(personalNotes)
    .set({ archived_at: p.at, archive_reason: p.reason, updated_at: p.at })
    .where(
      and(
        owned(owner),
        eq(personalNotes.id, p.id),
        eq(personalNotes.version, p.expected_version),
        isNull(personalNotes.archived_at),
      ),
    )
    .returning({ id: personalNotes.id });
  return updated.length > 0;
}

export async function linkReplacement(
  db: Executor,
  owner: NoteOwnerScope,
  id: string,
  replaced_by: string,
): Promise<void> {
  await db
    .update(personalNotes)
    .set({ replaced_by })
    .where(and(owned(owner), eq(personalNotes.id, id)));
}

export async function confirmNoteRow(
  db: Executor,
  owner: NoteOwnerScope,
  p: { id: string; expected_version: number; at: Date },
): Promise<boolean> {
  const updated = await db
    .update(personalNotes)
    .set({ confirmed_at: p.at, updated_at: p.at })
    .where(
      and(
        owned(owner),
        eq(personalNotes.id, p.id),
        eq(personalNotes.version, p.expected_version),
        isNull(personalNotes.archived_at),
      ),
    )
    .returning({ id: personalNotes.id });
  return updated.length > 0;
}

export async function touchActiveNote(
  db: Executor,
  owner: NoteOwnerScope,
  p: { id: string; expected_version: number; at: Date },
): Promise<boolean> {
  const updated = await db
    .update(personalNotes)
    .set({ updated_at: p.at })
    .where(
      and(
        owned(owner),
        eq(personalNotes.id, p.id),
        eq(personalNotes.version, p.expected_version),
        isNull(personalNotes.archived_at),
      ),
    )
    .returning({ id: personalNotes.id });
  return updated.length > 0;
}

export async function restoreNoteRow(
  db: Executor,
  owner: NoteOwnerScope,
  id: string,
  at: Date,
): Promise<boolean> {
  const updated = await db
    .update(personalNotes)
    .set({ archived_at: null, archive_reason: null, replaced_by: null, updated_at: at })
    .where(and(owned(owner), eq(personalNotes.id, id), isNotNull(personalNotes.archived_at)))
    .returning({ id: personalNotes.id });
  return updated.length > 0;
}

export async function deleteNoteRows(
  db: Executor,
  owner: NoteOwnerScope,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await db
    .delete(personalNotes)
    .where(and(owned(owner), inArray(personalNotes.id, [...ids])))
    .returning({ id: personalNotes.id });
  return deleted.length;
}
