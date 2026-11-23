import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/transport";
import type { PersonalNote } from "@/features/notes/api/notes-api";
import { LOCALES } from "@/lib/i18n";
import { notesDe, notesEn } from "@/lib/i18n/notes";
import {
  channelKey,
  editProblem,
  exportLabels,
  groupByStatus,
  isGone,
  NOTE_TEXT_MAX,
  noteActions,
  noteErrorKey,
  noteHref,
  noteTitle,
  reasonKey,
  sourceHref,
  sourcesLabel,
} from "./notes";
import { notesText } from "./notes-copy";

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

describe("groupByStatus", () => {
  test("orders confirmed, learned, mentioned once and drops empty groups", () => {
    const groups = groupByStatus([
      note({ id: "a", status: "mentioned_once" }),
      note({ id: "b", status: "confirmed" }),
    ]);
    expect(groups.map((group) => group.status)).toEqual(["confirmed", "mentioned_once"]);
  });

  test("inside a group sorts by area, then newest first, then id", () => {
    const [group] = groupByStatus([
      note({ id: "routine", area: "routines" }),
      note({ id: "old", area: "about", updated_at: "2026-10-01T00:00:00.000Z" }),
      note({ id: "new", area: "about", updated_at: "2026-11-05T00:00:00.000Z" }),
      note({ id: "b-tie", area: "people" }),
      note({ id: "a-tie", area: "people" }),
    ]);
    expect(group?.notes.map((entry) => entry.id)).toEqual([
      "new",
      "old",
      "a-tie",
      "b-tie",
      "routine",
    ]);
  });

  test("no notes give no groups", () => {
    expect(groupByStatus([])).toEqual([]);
  });
});

describe("labels", () => {
  test("the title is the abstract, or the text when there is none", () => {
    expect(noteTitle(note({}))).toBe("Short answers");
    expect(noteTitle(note({ abstract: null }))).toBe("Prefers short answers.");
    expect(noteTitle(note({ abstract: "  " }))).toBe("Prefers short answers.");
  });

  test("the sources line distinguishes none, one and several", () => {
    expect(sourcesLabel(0)).toEqual({ key: "notes.sources.none", count: 0 });
    expect(sourcesLabel(-1)).toEqual({ key: "notes.sources.none", count: 0 });
    expect(sourcesLabel(1)).toEqual({ key: "notes.sources.one", count: 1 });
    expect(sourcesLabel(3)).toEqual({ key: "notes.sources.other", count: 3 });
  });

  test("known channels have their own words, anything else is a conversation", () => {
    expect(channelKey("web")).toBe("notes.channel.web");
    expect(channelKey("mcp")).toBe("notes.channel.mcp");
    expect(channelKey("fax")).toBe("notes.channel.unknown");
    expect(channelKey(null)).toBe("notes.channel.unknown");
  });

  test("the archive reason is told in plain words", () => {
    expect(reasonKey("superseded")).toBe("notes.reason.superseded");
    expect(reasonKey("manual")).toBe("notes.reason.manual");
    expect(reasonKey("stale")).toBe("notes.reason.other");
    expect(reasonKey(null)).toBe("notes.reason.other");
  });
});

describe("links", () => {
  test("a note has its own address", () => {
    expect(noteHref("a b")).toBe("/notes/a%20b");
  });

  test("a source links to its message, to the conversation, or nowhere", () => {
    expect(sourceHref({ conversation_id: "c1", message_id: "m1" })).toBe("/chat/c1#message-m1");
    expect(sourceHref({ conversation_id: "c1", message_id: null })).toBe("/chat/c1");
    expect(sourceHref({ conversation_id: null, message_id: "m1" })).toBeNull();
  });
});

describe("noteActions", () => {
  test("an unconfirmed note in use offers every action once", () => {
    expect(noteActions(note({}), true)).toEqual(["confirm", "edit", "share", "archive", "forget"]);
  });

  test("a confirmed note has nothing left to confirm", () => {
    expect(noteActions(note({ confirmed_at: "2026-11-02T00:00:00.000Z" }), true)).toEqual([
      "edit",
      "share",
      "archive",
      "forget",
    ]);
  });

  test("sharing needs the right to add to the inbox", () => {
    expect(noteActions(note({}), false)).not.toContain("share");
  });

  test("an archived note can only be restored or forgotten", () => {
    expect(noteActions(note({ archived_at: "2026-11-02T00:00:00.000Z" }), true)).toEqual([
      "restore",
      "forget",
    ]);
  });
});

describe("editProblem", () => {
  test("an empty and an overlong text are refused, the limit itself is fine", () => {
    expect(editProblem("   ")).toEqual({ key: "notes.edit.empty" });
    expect(editProblem("x".repeat(NOTE_TEXT_MAX + 1))).toEqual({
      key: "notes.edit.tooLong",
      max: NOTE_TEXT_MAX,
    });
    expect(editProblem(` ${"x".repeat(NOTE_TEXT_MAX)} `)).toBeNull();
  });
});

describe("noteErrorKey", () => {
  test.each([
    ["version_conflict", 409, "notes.error.versionConflict"],
    ["address_taken", 409, "notes.error.addressTaken"],
    ["note_limit", 409, "notes.error.noteLimit"],
    ["secret_in_text", 422, "notes.error.secretInText"],
    ["not_found", 404, "notes.error.notFound"],
    ["human_confirmation_required", 403, "notes.error.signedInOnly"],
    ["person_required", 403, "notes.error.signedInOnly"],
    ["permission_denied", 403, "notes.error.shareNotAllowed"],
    ["something_else", 404, "notes.error.notFound"],
    ["something_else", 500, "notes.error.generic"],
  ] as const)("%s (%i) reads %s", (code, status, key) => {
    expect(noteErrorKey(new ApiError(status, { code }, null))).toBe(key);
  });

  test("anything that is not an API failure is generic", () => {
    expect(noteErrorKey(new Error("offline"))).toBe("notes.error.generic");
    expect(isGone(new Error("offline"))).toBe(false);
    expect(isGone(new ApiError(404, {}, null))).toBe(true);
    expect(isGone(new ApiError(409, {}, null))).toBe(false);
  });
});

describe("notes catalog", () => {
  test("German and English carry the same keys and the same placeholders", () => {
    expect(Object.keys(notesDe).sort()).toEqual(Object.keys(notesEn).sort());
    const placeholders = (text: string) => (text.match(/\{[^}]+\}/g) ?? []).sort();
    for (const key of Object.keys(notesEn) as Array<keyof typeof notesEn>) {
      expect(placeholders(notesDe[key])).toEqual(placeholders(notesEn[key]));
    }
  });

  test("no copy carries an exclamation mark or straight quotes", () => {
    for (const text of [...Object.values(notesEn), ...Object.values(notesDe)]) {
      expect(text).not.toMatch(/[!"']/);
    }
  });

  test("the export headings come from the catalog and fit the engine's limit", () => {
    for (const locale of LOCALES) {
      const labels = exportLabels((key, values) => notesText(locale, key, values));
      const all = [
        labels.title,
        labels.empty,
        labels.quote,
        ...Object.values(labels.status),
        ...Object.values(labels.area),
      ];
      expect(all).toHaveLength(11);
      for (const label of all) {
        expect(label.length).toBeGreaterThan(0);
        expect(label.length).toBeLessThanOrEqual(80);
      }
    }
    expect(exportLabels((key) => notesText("en", key)).status.learned).toBe("Learned");
  });

  test("text is interpolated per locale", () => {
    expect(LOCALES).toEqual(["en", "de"]);
    expect(notesText("en", "notes.sources.other", { count: 3 })).toBe("Said in 3 conversations");
    expect(notesText("de", "notes.sources.one", { count: 1 })).toBe(
      notesDe["notes.sources.one"].replace("{count}", "1"),
    );
    expect(notesText("de", "notes.title")).not.toBe("");
  });
});
