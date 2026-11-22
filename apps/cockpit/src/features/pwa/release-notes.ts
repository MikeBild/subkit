import type { Highlights } from "@/app/release-notes.generated";
import type { Locale } from "@/lib/i18n";

export type ReleaseNoteSource = "highlights" | "commits";

export function releaseNotesFor(
  group: { notes: string[]; highlights: Highlights | null },
  locale: Locale,
): { source: ReleaseNoteSource; notes: string[] } {
  const highlights = group.highlights?.[locale] ?? [];
  return highlights.length > 0
    ? { source: "highlights", notes: highlights }
    : { source: "commits", notes: group.notes };
}
