export type ReleaseNoteSource = "highlights" | "commits";

export function releaseNotesFor(group: { notes: string[]; highlights: string[] | null }): {
  source: ReleaseNoteSource;
  notes: string[];
} {
  const highlights = group.highlights ?? [];
  return highlights.length > 0
    ? { source: "highlights", notes: highlights }
    : { source: "commits", notes: group.notes };
}
