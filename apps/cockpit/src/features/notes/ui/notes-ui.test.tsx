import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SETUP_KEY } from "@/api/setup";
import { render } from "@/components/cockpit/patterns/test-utils";
import type { PersonalNote } from "@/features/notes/api/notes-api";
import { groupByStatus } from "@/features/notes/model/notes";
import { notesDe, notesEn } from "@/lib/i18n/notes";
import { NotesList } from "./notes-list";
import { SaveNotesSwitch } from "./save-notes-switch";

function note(extra: Partial<PersonalNote>): PersonalNote {
  return {
    id: "n1",
    area: "preferences",
    slug: "answers",
    origin: "stated",
    fact_kind: "preference",
    text: "Prefers short answers.",
    abstract: "Short answers",
    status: "mentioned_once",
    confirmed_at: null,
    version: 1,
    archived_at: null,
    archive_reason: null,
    source_count: 1,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    ...extra,
  };
}

function switchHtml(saveNewNotes: boolean | null | undefined, locale: "de" | "en" = "en") {
  const client = new QueryClient();
  if (saveNewNotes !== null)
    client.setQueryData(
      SETUP_KEY,
      saveNewNotes === undefined ? {} : { save_new_notes: saveNewNotes },
    );
  return render(
    <QueryClientProvider client={client}>
      <SaveNotesSwitch />
    </QueryClientProvider>,
    locale,
  );
}

describe("the notes list", () => {
  const groups = groupByStatus([
    note({ id: "once" }),
    note({
      id: "sure",
      status: "confirmed",
      abstract: "Invoices on Friday",
      area: "routines",
      source_count: 3,
    }),
    note({ id: "own", status: "confirmed", abstract: null, source_count: 0 }),
  ]);

  test("shows one section per status with its notes, each opening with one click", () => {
    const html = render(<NotesList groups={groups} onOpen={() => {}} />, "en");
    expect(html.indexOf(notesEn["notes.status.confirmed"])).toBeLessThan(
      html.indexOf(notesEn["notes.status.mentioned_once"]),
    );
    expect(html).not.toContain(notesEn["notes.status.learned.hint"]);
    expect(html).toContain("Invoices on Friday");
    expect(html).toContain("Prefers short answers.");
    expect(html).toContain("Said in 3 conversations");
    expect(html).toContain(notesEn["notes.sources.none"]);
    expect(html).toContain(notesEn["notes.area.routines"]);
    expect(html.match(/data-testid="notes-item-[a-z]+-open"/g)).toHaveLength(3);
  });

  test("reads in German as well", () => {
    const html = render(<NotesList groups={groups} onOpen={() => {}} />, "de");
    expect(html).toContain(notesDe["notes.status.confirmed"]);
    expect(html).not.toContain(notesEn["notes.status.confirmed"]);
  });
});

describe("the save-new-notes switch", () => {
  test("names the setting and says who can read the notes", () => {
    const html = switchHtml(true);
    expect(html).toContain(notesEn["notes.save.label"]);
    expect(html).toContain("Only you can read them.");
    expect(switchHtml(true, "de")).toContain(notesDe["notes.save.label"]);
  });

  test("is on unless the person switched it off", () => {
    expect(switchHtml(true)).toContain('aria-checked="true"');
    expect(switchHtml(undefined)).toContain('aria-checked="true"');
    expect(switchHtml(false)).toContain('aria-checked="false"');
  });

  test("stays locked until the choice has loaded", () => {
    expect(switchHtml(null)).toMatch(
      /data-testid="settings-notes-save-switch"[^>]*disabled|disabled=""[^>]*data-testid="settings-notes-save-switch"/,
    );
  });
});
