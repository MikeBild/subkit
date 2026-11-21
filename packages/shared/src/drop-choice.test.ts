import { describe, expect, test } from "bun:test";
import { DROP_CHOICES, placedHref } from "./drop-choice.ts";

describe("where a drop goes", () => {
  test("four choices, in the order the sheet shows them", () => {
    expect(DROP_CHOICES).toEqual(["file", "source", "chat", "inbox"]);
  });

  test("opens the placed item, its list, or the chat", () => {
    expect(placedHref("file", ["f1"])).toBe("/files/f1");
    expect(placedHref("file", ["f1", "f2"])).toBe("/files");
    expect(placedHref("source", ["s1"])).toBe("/knowledge/s1");
    expect(placedHref("inbox", [])).toBe("/intake");
    expect(placedHref("chat", ["a1"])).toBe("/chat");
    expect(placedHref("file", ["a b"])).toBe("/files/a%20b");
  });
});
