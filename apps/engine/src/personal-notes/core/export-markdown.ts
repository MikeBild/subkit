import { NOTE_AREAS, type NoteArea } from "./apply-proposals.ts";
import { NOTE_STATUSES, type NoteStatus } from "./status.ts";

export interface ExportedNote {
  readonly area: NoteArea;
  readonly status: NoteStatus;
  readonly text: string;
  readonly quotes: readonly string[];
}

export interface ExportLabels {
  readonly title: string;
  readonly empty: string;
  readonly quote: string;
  readonly status: Readonly<Record<NoteStatus, string>>;
  readonly area: Readonly<Record<NoteArea, string>>;
}

export const EXPORT_LABEL_MAX_CHARS = 80;

export const DEFAULT_EXPORT_LABELS: ExportLabels = {
  title: "My personal notes",
  empty: "There are no notes yet.",
  quote: "You wrote",
  status: {
    confirmed: "Confirmed by you",
    learned: "Learned",
    mentioned_once: "Mentioned once",
  },
  area: {
    about: "About you",
    preferences: "How you like things",
    people: "People",
    routines: "Routines",
    lessons: "Lessons",
  },
};

const STATUS_ORDER: readonly NoteStatus[] = [...NOTE_STATUSES].reverse();

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function heading(label: string): string {
  return oneLine(label).replace(/^#+\s*/u, "");
}

export function exportMarkdown(
  notes: readonly ExportedNote[],
  labels: ExportLabels = DEFAULT_EXPORT_LABELS,
): string {
  const lines: string[] = [`# ${heading(labels.title)}`, ""];
  if (notes.length === 0) return [...lines, oneLine(labels.empty), ""].join("\n");
  for (const status of STATUS_ORDER) {
    const inStatus = notes.filter((note) => note.status === status);
    if (inStatus.length === 0) continue;
    lines.push(`## ${heading(labels.status[status])}`, "");
    for (const area of NOTE_AREAS) {
      const inArea = inStatus.filter((note) => note.area === area);
      if (inArea.length === 0) continue;
      lines.push(`### ${heading(labels.area[area])}`, "");
      for (const note of inArea) {
        lines.push(`- ${oneLine(note.text)}`);
        for (const quote of note.quotes)
          lines.push(`  > ${oneLine(labels.quote)}: ${oneLine(quote)}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
