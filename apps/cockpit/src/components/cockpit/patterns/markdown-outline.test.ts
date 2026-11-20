import { describe, expect, test } from "bun:test";
import { markdownOutline, outlineIndent, showsOutline } from "./markdown-outline";

describe("markdown outline", () => {
  test("lists the headings in order with their level and plain text", () => {
    expect(
      markdownOutline(
        "# Titel\n\nText\n\n## Erster **Teil**\n### `Code` und [Link](https://x.test)\n",
      ),
    ).toEqual([
      { level: 1, text: "Titel" },
      { level: 2, text: "Erster Teil" },
      { level: 3, text: "Code und Link" },
    ]);
  });

  test("skips headings inside code fences and empty headings", () => {
    const text = "## Eins\n```md\n# kein Titel\n```\n~~~\n## auch nicht\n~~~\n## \n## Zwei ##";
    expect(markdownOutline(text).map((entry) => entry.text)).toEqual(["Eins", "Zwei"]);
  });

  test("a longer fence is not closed by a shorter one", () => {
    const text = "````\n```\n# innen\n```\n````\n# aussen";
    expect(markdownOutline(text).map((entry) => entry.text)).toEqual(["aussen"]);
  });

  test("a table of contents needs three headings", () => {
    expect(showsOutline(markdownOutline("# A\n## B"))).toBe(false);
    expect(showsOutline(markdownOutline("# A\n## B\n## C"))).toBe(true);
    expect(showsOutline([])).toBe(false);
  });

  test("indents below the shallowest heading, at most two steps", () => {
    const entries = markdownOutline("## A\n### B\n#### C\n###### D");
    expect(entries.map((entry) => outlineIndent(entries, entry))).toEqual([0, 1, 2, 2]);
  });
});
