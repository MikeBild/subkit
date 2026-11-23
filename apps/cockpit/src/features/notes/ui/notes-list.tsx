import { Panel, Pill } from "@ui/atoms/pill";
import { SectionHeading } from "@/components/cockpit/patterns";
import type { PersonalNote } from "@/features/notes/api/notes-api";
import { useNotesText } from "@/features/notes/hooks/use-notes-text";
import {
  NOTE_AREA_LABEL,
  NOTE_STATUS_HINT,
  NOTE_STATUS_LABEL,
  type NoteGroup,
  noteTitle,
  sourcesLabel,
} from "@/features/notes/model/notes";

export function NotesList({
  groups,
  onOpen,
}: {
  groups: readonly NoteGroup[];
  onOpen(note: PersonalNote): void;
}) {
  const nt = useNotesText();
  return (
    <div className="grid gap-5" data-testid="notes-list">
      {groups.map((group) => (
        <section
          key={group.status}
          className="grid gap-2"
          aria-labelledby={`notes-group-${group.status}`}
          data-testid={`notes-group-${group.status}`}
        >
          <div className="grid gap-0.5">
            <SectionHeading
              id={`notes-group-${group.status}`}
              className="text-sm font-semibold text-foreground"
            >
              {nt(NOTE_STATUS_LABEL[group.status])}
            </SectionHeading>
            <p className="text-sm text-muted-foreground">{nt(NOTE_STATUS_HINT[group.status])}</p>
          </div>
          <Panel className="px-4 py-1">
            <ul className="divide-y">
              {group.notes.map((note) => {
                const sources = sourcesLabel(note.source_count);
                return (
                  <li key={note.id} data-testid={`notes-item-${note.id}`}>
                    <button
                      type="button"
                      onClick={() => onOpen(note)}
                      data-testid={`notes-item-${note.id}-open`}
                      className="flex min-h-11 w-full flex-wrap items-center gap-3 rounded-md py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium [overflow-wrap:anywhere]">
                          {noteTitle(note)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {nt(sources.key, { count: sources.count })}
                        </span>
                      </span>
                      <Pill tone="neutral" className="shrink-0">
                        {nt(NOTE_AREA_LABEL[note.area])}
                      </Pill>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </section>
      ))}
    </div>
  );
}
