// Unit tests for the paste store + ref expansion.

import { describe, expect, test } from "bun:test";

import {
  createPasteStore,
  expandRefs,
  formatFileRef,
  formatImageRef,
  formatTextRef,
  looksLikePaste,
} from "../repl/paste-store.ts";

describe("paste-store: addText", () => {
  test("returns incrementing ids", () => {
    const s = createPasteStore();
    expect(s.addText("a").id).toBe(1);
    expect(s.addText("b").id).toBe(2);
  });

  test("single-line text gets a no-lines ref", () => {
    const s = createPasteStore();
    const { ref } = s.addText("hello");
    expect(ref).toBe("[Pasted text #1]");
  });

  test("multi-line text reports the newline count", () => {
    const s = createPasteStore();
    const { ref, lines } = s.addText("one\ntwo\nthree");
    expect(lines).toBe(2);
    expect(ref).toBe("[Pasted text #1 +2 lines]");
  });

  test("\\r\\n line endings are counted once", () => {
    const s = createPasteStore();
    expect(s.addText("a\r\nb\r\nc").lines).toBe(2);
  });
});

describe("paste-store: addImage / addFile", () => {
  test("addImage generates an image ref and persists the path", () => {
    const s = createPasteStore();
    const { id, ref } = s.addImage({ path: "/tmp/paste.png", mediaType: "image/png" });
    expect(ref).toBe("[Image #1]");
    const item = s.get(id);
    expect(item?.kind).toBe("image");
    if (item?.kind === "image") {
      expect(item.path).toBe("/tmp/paste.png");
      expect(item.mediaType).toBe("image/png");
    }
  });

  test("addFile embeds the filename into the ref", () => {
    const s = createPasteStore();
    const { ref } = s.addFile({ path: "/tmp/invoice.pdf", filename: "invoice.pdf" });
    expect(ref).toBe("[File invoice.pdf #1]");
  });

  test("formatters are exposed for reuse", () => {
    expect(formatTextRef(7, 0)).toBe("[Pasted text #7]");
    expect(formatTextRef(7, 3)).toBe("[Pasted text #7 +3 lines]");
    expect(formatImageRef(4)).toBe("[Image #4]");
    expect(formatFileRef(9, "x.pdf")).toBe("[File x.pdf #9]");
  });
});

describe("paste-store: expandRefs", () => {
  test("returns the input unchanged when there are no refs", () => {
    const s = createPasteStore();
    const { prompt, attachmentPaths, consumedIds } = expandRefs("hello", s);
    expect(prompt).toBe("hello");
    expect(attachmentPaths).toEqual([]);
    expect(consumedIds).toEqual([]);
  });

  test("inlines text refs back into the prompt", () => {
    const s = createPasteStore();
    const { ref } = s.addText("the long body\nwith lines");
    const { prompt, consumedIds } = expandRefs(`please review ${ref}`, s);
    expect(prompt).toBe("please review the long body\nwith lines");
    expect(consumedIds).toEqual([1]);
  });

  test("collects image / file paths into attachmentPaths", () => {
    const s = createPasteStore();
    const { ref: imgRef } = s.addImage({ path: "/tmp/a.png" });
    const { ref: fileRef } = s.addFile({ path: "/tmp/b.pdf", filename: "b.pdf" });
    const { prompt, attachmentPaths } = expandRefs(`see ${imgRef} and ${fileRef}`, s);
    // Image/File refs are kept visible in the prompt; attachments fan
    // out via the mention resolver.
    expect(prompt).toContain("[Image #1]");
    expect(prompt).toContain("[File b.pdf #2]");
    expect(attachmentPaths).toContain("/tmp/a.png");
    expect(attachmentPaths).toContain("/tmp/b.pdf");
  });

  test("unknown / stale refs are left as-is", () => {
    const s = createPasteStore();
    const { prompt } = expandRefs("stale [Pasted text #99] still here", s);
    expect(prompt).toContain("[Pasted text #99]");
  });

  test("expansion works with multiple refs in order", () => {
    const s = createPasteStore();
    const r1 = s.addText("A");
    const r2 = s.addText("B");
    const { prompt } = expandRefs(`${r1.ref} then ${r2.ref}`, s);
    expect(prompt).toBe("A then B");
  });
});

describe("paste-store: looksLikePaste", () => {
  test("single keystrokes are not a paste", () => {
    expect(looksLikePaste("a")).toBe(false);
    expect(looksLikePaste("abc")).toBe(false);
  });

  test("short chunks with a newline are not treated as large paste", () => {
    expect(looksLikePaste("ab\n")).toBe(false);
    expect(looksLikePaste("abc\n")).toBe(false);
  });

  test("only chunks over the Codex large-paste threshold are paste refs", () => {
    expect(looksLikePaste("x".repeat(1001))).toBe(true);
    expect(looksLikePaste("x".repeat(1000))).toBe(false);
  });
});

describe("paste-store: delete / clear", () => {
  test("delete removes one item; clear wipes all", () => {
    const s = createPasteStore();
    s.addText("a");
    s.addText("b");
    expect(s.all().length).toBe(2);
    s.delete(1);
    expect(s.all().length).toBe(1);
    s.clear();
    expect(s.all().length).toBe(0);
  });
});
