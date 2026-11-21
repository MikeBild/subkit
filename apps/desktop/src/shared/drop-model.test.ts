import { describe, expect, test } from "bun:test";
import {
  baseName,
  choiceBlocker,
  type DroppedFile,
  inboxFileNote,
  inboxRoute,
  isTextFile,
  MAX_DROP_FILES,
  MAX_FILE_BYTES,
  MAX_INBOX_BYTES,
  openDrop,
  placedHref,
  reduceDrop,
  sourceName,
} from "./drop-model.ts";

const file = (name: string, size = 1000): DroppedFile => ({ name, size });

describe("files", () => {
  test("knows which files the inbox can read", () => {
    expect(isTextFile("data.csv")).toBe(true);
    expect(isTextFile("Notes.MD")).toBe(true);
    expect(isTextFile("foto.png")).toBe(false);
    expect(isTextFile(".env")).toBe(false);
    expect(isTextFile("README")).toBe(false);
  });

  test("keeps only the file name, never the folder", () => {
    expect(baseName("/Users/anna/Dokumente/Plan.md")).toBe("Plan.md");
    expect(baseName("C:\\Users\\anna\\Plan.md")).toBe("Plan.md");
    expect(sourceName("/tmp/Handbuch Vertrieb.pdf")).toBe("Handbuch Vertrieb");
  });
});

describe("choices", () => {
  test("every choice is blocked offline", () => {
    expect(choiceBlocker("file", [file("a.md")], false)).toEqual({ reason: "offline" });
  });

  test("“Attach in chat” takes up to ten files of 5 MB", () => {
    expect(choiceBlocker("chat", [file("a.pdf")], true)).toBeNull();
    const eleven = Array.from({ length: 11 }, (_, i) => file(`f${i}.md`));
    expect(choiceBlocker("chat", eleven, true)).toEqual({ reason: "tooMany", max: 10 });
    expect(choiceBlocker("chat", [file("a.pdf", MAX_FILE_BYTES + 1)], true)).toEqual({
      reason: "tooLarge",
      max: MAX_FILE_BYTES,
    });
  });

  test("the inbox reads text as a note and takes allowed files as files", () => {
    expect(inboxRoute(file("a.md"))).toBe("text");
    expect(inboxRoute(file("a.html"))).toBe("text");
    expect(inboxRoute(file("scan.pdf", 3_000_000))).toBe("file");
    expect(inboxRoute(file("big.csv", MAX_INBOX_BYTES + 1))).toBe("file");
    expect(inboxRoute(file("foto.png"))).toBe("file");
    expect(inboxRoute(file("big.html", MAX_INBOX_BYTES + 1))).toEqual({
      reason: "tooLarge",
      max: MAX_INBOX_BYTES,
    });
    expect(inboxRoute(file("scan.pdf", MAX_FILE_BYTES + 1))).toEqual({
      reason: "tooLarge",
      max: MAX_FILE_BYTES,
    });
    expect(inboxRoute(file("vector.svg"))).toEqual({ reason: "unsupported" });
    expect(inboxRoute(file("Vertrag.docx"))).toEqual({ reason: "unsupported" });
  });

  test("the inbox choice names the first file it cannot take", () => {
    expect(choiceBlocker("inbox", [file("a.md"), file("b.png")], true)).toBeNull();
    expect(choiceBlocker("inbox", [file("a.md"), file("b.docx")], true)).toEqual({
      reason: "unsupported",
    });
  });

  test("files and sources follow the server limits", () => {
    expect(choiceBlocker("file", [file("a.png", MAX_FILE_BYTES)], true)).toBeNull();
    expect(choiceBlocker("file", [file("a.png", MAX_FILE_BYTES + 1)], true)).toEqual({
      reason: "tooLarge",
      max: MAX_FILE_BYTES,
    });
    expect(choiceBlocker("source", [file("a.pdf", MAX_FILE_BYTES + 1)], true)).toBeNull();
  });

  test("opens the placed item, its list, or the chat", () => {
    expect(placedHref("file", ["f1"])).toBe("/files/f1");
    expect(placedHref("file", ["f1", "f2"])).toBe("/files");
    expect(placedHref("source", ["s1"])).toBe("/knowledge/s1");
    expect(placedHref("inbox", [])).toBe("/intake");
    expect(placedHref("chat", ["a1"])).toBe("/chat");
  });
});

describe("drop sheet", () => {
  test("opens only with files and keeps at most 20", () => {
    expect(openDrop([], "dock")).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => file(`f${i}.md`));
    expect(openDrop(many, "tray")?.files).toHaveLength(MAX_DROP_FILES);
  });

  test("placing blocks a second choice; a failure lets the person choose again", () => {
    const sheet = openDrop([file("a.md")], "dock");
    if (!sheet) throw new Error("sheet");
    const placing = reduceDrop(sheet, { type: "place", choice: "file" });
    expect(placing).toMatchObject({ phase: "placing", choice: "file" });
    expect(reduceDrop(placing, { type: "place", choice: "inbox" })).toBe(placing);
    expect(reduceDrop(placing, { type: "failed" }).phase).toBe("failed");
  });

  test("another drop adds new files and skips known names", () => {
    const sheet = openDrop([file("a.md")], "dock");
    if (!sheet) throw new Error("sheet");
    const added = reduceDrop(sheet, {
      type: "add",
      files: [file("a.md"), file("b.md")],
      via: "tray",
    });
    expect(added.files.map((entry) => entry.name)).toEqual(["a.md", "b.md"]);
    expect(added.via).toBe("tray");
  });

  test("a text file becomes an inbox note named after the file", () => {
    const now = new Date("2026-11-21T10:00:00.000Z");
    expect(inboxFileNote("/x/Idee.md", " Text ", now, "r1")).toEqual({
      client_request_id: "r1",
      title: "Idee.md",
      body: "Text",
      captured_at: "2026-11-21T10:00:00.000Z",
    });
    expect(inboxFileNote("leer.txt", "  ", now, "r2")).toBeNull();
  });
});
