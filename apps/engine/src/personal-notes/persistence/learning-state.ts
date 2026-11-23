import { and, eq, sql } from "drizzle-orm";
import { type Executor, userSetupPreferences } from "../../db/index.ts";
import type { NoteOwnerScope } from "../sealing.ts";

export interface NotesLearning {
  readonly save_new_notes: boolean;
  readonly learned_through: Date | null;
}

export async function readNotesLearning(
  db: Executor,
  owner: NoteOwnerScope,
): Promise<NotesLearning> {
  const [row] = await db
    .select({
      save_new_notes: userSetupPreferences.save_new_notes,
      learned_through: userSetupPreferences.notes_learned_through,
    })
    .from(userSetupPreferences)
    .where(
      and(
        eq(userSetupPreferences.tenant_id, owner.tenant_id),
        eq(userSetupPreferences.user_id, owner.user_id),
      ),
    )
    .limit(1);
  return {
    save_new_notes: row?.save_new_notes ?? true,
    learned_through: row?.learned_through ?? null,
  };
}

export async function advanceNotesLearnedThrough(
  db: Executor,
  owner: NoteOwnerScope,
  through: Date,
): Promise<void> {
  const next = sql`${through.toISOString()}::timestamptz`;
  await db
    .insert(userSetupPreferences)
    .values({ tenant_id: owner.tenant_id, user_id: owner.user_id, notes_learned_through: through })
    .onConflictDoUpdate({
      target: [userSetupPreferences.tenant_id, userSetupPreferences.user_id],
      set: {
        notes_learned_through: sql`greatest(coalesce(${userSetupPreferences.notes_learned_through}, ${next}), ${next})`,
      },
    });
}
