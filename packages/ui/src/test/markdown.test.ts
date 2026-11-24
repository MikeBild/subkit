import { describe, expect, it } from "bun:test";
import { applyFormat, headings, refToken, stripTitleHeading } from "@ui/lib/markdown";
import { groupBy, matches } from "@ui/lib/search";

describe("markdown helpers", () => {
  it("finds headings outside code fences with unique ids", () => {
    const h = headings("# A\n```\n# not\n```\n## B\n## B");
    expect(h.map((x) => x.id)).toEqual(["a", "b", "b-1"]);
  });
  it("ignores headings inside tilde fences (#562)", () => {
    const h = headings("## Before\n~~~bash\n### EXAMPLE ONLY — NOT A HEADING\n~~~\n## After");
    expect(h.map((x) => x.text)).toEqual(["Before", "After"]);
  });
  it("closes a fence only with the same char and at least the opening length", () => {
    const texts = (md: string) => headings(md).map((x) => x.text);
    expect(texts("~~~\n```\n# inside\n```\n~~~\n# out")).toEqual(["out"]);
    expect(texts("````\n```\n# inside\n````\n# out")).toEqual(["out"]);
    expect(texts("~~~~\n~~~\n# inside\n~~~~~\n# out")).toEqual(["out"]);
    expect(texts("   ```\n# inside\n   ```\n# out")).toEqual(["out"]);
    expect(texts("    ```\n# indented code, not a fence")).toEqual(["indented code, not a fence"]);
  });
  it("treats an unclosed fence as running to the end", () => {
    expect(headings("# A\n~~~\n# B\n## C").map((x) => x.text)).toEqual(["A"]);
  });
  it("bold wraps the selection, list prefixes each line", () => {
    expect(applyFormat("hallo welt", 0, 5, "bold").value).toBe("**hallo** welt");
    expect(applyFormat("a\nb", 0, 3, "list").value).toBe("- a\n- b");
    expect(applyFormat("a\nb", 0, 3, "olist").value).toBe("1. a\n2. b");
  });
  it("a reference is @prefix:name", () => {
    expect(refToken("attachment", "angebot.pdf")).toBe("@attachment:angebot.pdf");
    expect(refToken("note", "Rollbacks")).toBe("@note:Rollbacks");
  });
  it("strips a leading H1 only when it repeats the page title", () => {
    expect(stripTitleHeading("# Tonalität und Stil\n\nText", "Tonalität und Stil")).toBe("Text");
    expect(stripTitleHeading("# Anderer Titel\n\nText", "Tonalität und Stil")).toBe(
      "# Anderer Titel\n\nText",
    );
    expect(stripTitleHeading("## Kein H1\n\nText", "Kein H1")).toBe("## Kein H1\n\nText");
  });
});

describe("list helpers", () => {
  it("matches case-insensitively and treats an empty query as a match", () => {
    expect(matches("", "x")).toBe(true);
    expect(matches("INVOICE", "Invoice attachments")).toBe(true);
    expect(matches("receipt", "Invoice")).toBe(false);
  });
  it("groups in first-seen order", () => {
    expect(groupBy(["a1", "b1", "a2"], (s) => s[0] ?? "")).toEqual([
      ["a", ["a1", "a2"]],
      ["b", ["b1"]],
    ]);
    expect(groupBy([1, 2], null)).toEqual([["", [1, 2]]]);
  });
});
