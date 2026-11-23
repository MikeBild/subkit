export type NoteStatus = "mentioned_once" | "learned" | "confirmed";

export const NOTE_STATUSES = ["mentioned_once", "learned", "confirmed"] as const;

export const LEARNED_AFTER_STATED = 2;
export const LEARNED_AFTER_INFERRED = 3;

export interface NoteStatusInput {
  readonly confirmed_at: Date | null;
  readonly origin: "stated" | "inferred";
  readonly distinct_source_count: number;
}

export function noteStatus(note: NoteStatusInput): NoteStatus {
  if (note.confirmed_at) return "confirmed";
  const needed = note.origin === "stated" ? LEARNED_AFTER_STATED : LEARNED_AFTER_INFERRED;
  return note.distinct_source_count >= needed ? "learned" : "mentioned_once";
}

export function distinctSourceCount(
  sources: readonly {
    readonly conversation_id: string | null;
    readonly message_id: string | null;
  }[],
): number {
  const seen = new Set<string>();
  let orphaned = 0;
  for (const source of sources) {
    const key = source.conversation_id ?? source.message_id;
    if (key) seen.add(key);
    else orphaned += 1;
  }
  return seen.size + orphaned;
}
