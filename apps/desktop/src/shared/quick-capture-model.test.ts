import { describe, expect, test } from "bun:test";
import {
  canSend,
  INITIAL_CAPTURE,
  intakeHref,
  intakeNote,
  modifierLabel,
  NOTE_MAX_CHARS,
  noteTitle,
  reduceCapture,
  shortcutLabel,
} from "./quick-capture-model.ts";

describe("quick capture state", () => {
  test("editing → sending → sent, and a failure keeps the text for another try", () => {
    const sending = reduceCapture(INITIAL_CAPTURE, { type: "send" });
    expect(sending.phase).toBe("sending");
    expect(reduceCapture(sending, { type: "send" })).toBe(sending);
    expect(reduceCapture(sending, { type: "sent", itemId: "i-1" })).toEqual({
      phase: "sent",
      itemId: "i-1",
    });
    const failed = reduceCapture(sending, { type: "failed" });
    expect(failed.phase).toBe("failed");
    expect(reduceCapture(failed, { type: "send" }).phase).toBe("sending");
    expect(reduceCapture(failed, { type: "reset" })).toEqual(INITIAL_CAPTURE);
  });

  test("ignores late answers outside of sending", () => {
    expect(reduceCapture(INITIAL_CAPTURE, { type: "sent", itemId: "x" })).toBe(INITIAL_CAPTURE);
    expect(reduceCapture(INITIAL_CAPTURE, { type: "failed" })).toBe(INITIAL_CAPTURE);
  });

  test("sends only text, online and not twice", () => {
    expect(canSend("  ", "editing", true)).toBe(false);
    expect(canSend("Idee", "editing", true)).toBe(true);
    expect(canSend("Idee", "editing", false)).toBe(false);
    expect(canSend("Idee", "sending", true)).toBe(false);
    expect(canSend("x".repeat(NOTE_MAX_CHARS + 1), "editing", true)).toBe(false);
  });
});

describe("intake note", () => {
  test("takes the first non-empty line as title and cuts it at 60 characters", () => {
    expect(noteTitle("\n  Rechnung prüfen \nDetails")).toBe("Rechnung prüfen");
    const long = noteTitle("a".repeat(80));
    expect([...long]).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
  });

  test("builds the request body with the given time and request id", () => {
    const now = new Date("2026-11-21T09:30:00.000Z");
    expect(intakeNote("  Idee\nmehr  ", now, "7d1d0c8e-2b6b-4b1a-9b8a-111111111111")).toEqual({
      client_request_id: "7d1d0c8e-2b6b-4b1a-9b8a-111111111111",
      title: "Idee",
      body: "Idee\nmehr",
      captured_at: "2026-11-21T09:30:00.000Z",
    });
    expect(intakeNote("   ", now, "id")).toBeNull();
  });

  test("opens the note itself or the inbox", () => {
    expect(intakeHref("abc")).toBe("/intake/abc");
    expect(intakeHref(null)).toBe("/intake");
  });
});

describe("shortcut label", () => {
  const de = { ctrl: "Strg", space: "Leertaste" };
  const en = { ctrl: "Ctrl", space: "Space" };

  test("macOS shows symbols and the localized key name", () => {
    expect(shortcutLabel("Alt+Space", "darwin", de)).toBe("⌥ Leertaste");
    expect(shortcutLabel("Alt+Space", "darwin", en)).toBe("⌥ Space");
    expect(shortcutLabel("CommandOrControl+Shift+K", "darwin", en)).toBe("⌘ ⇧ K");
  });

  test("Windows and Linux spell the keys out", () => {
    expect(shortcutLabel("Control+Alt+Space", "win32", de)).toBe("Strg + Alt + Leertaste");
    expect(shortcutLabel("Control+Alt+Space", "linux", en)).toBe("Ctrl + Alt + Space");
  });

  test("the send modifier follows the platform", () => {
    expect(modifierLabel("darwin", de)).toBe("⌘");
    expect(modifierLabel("win32", de)).toBe("Strg");
  });
});
