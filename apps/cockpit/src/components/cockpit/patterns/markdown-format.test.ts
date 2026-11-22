import { describe, expect, test } from "bun:test";
import { applyMarkdownEdit, formatMarkdown } from "./markdown-format";

const run = (
  text: string,
  from: number,
  to: number,
  format: Parameters<typeof formatMarkdown>[2],
) => {
  const edit = formatMarkdown(text, { from, to }, format);
  const next = applyMarkdownEdit(text, edit);
  return { next, selected: next.slice(edit.selection.from, edit.selection.to), edit };
};

describe("markdown toolbar", () => {
  test("bold and italic wrap the selection and keep it selected", () => {
    expect(run("Hallo Welt", 6, 10, "bold")).toMatchObject({
      next: "Hallo **Welt**",
      selected: "Welt",
    });
    expect(run("Hallo Welt", 6, 10, "italic").next).toBe("Hallo _Welt_");
  });

  test("a second bold on the same words takes the marks off again", () => {
    expect(run("Hallo **Welt**", 8, 12, "bold").next).toBe("Hallo Welt");
  });

  test("heading, list and numbered list prefix every touched line and toggle back", () => {
    expect(run("eins\nzwei", 0, 9, "list").next).toBe("- eins\n- zwei");
    expect(run("- eins\n- zwei", 0, 13, "list").next).toBe("eins\nzwei");
    expect(run("eins\nzwei", 2, 7, "ordered").next).toBe("1. eins\n2. zwei");
    expect(run("Titel", 2, 2, "heading").next).toBe("## Titel");
    expect(run("## Titel", 3, 3, "heading").next).toBe("Titel");
  });

  test("a link wraps the words and selects the address to type over", () => {
    const linked = run("siehe Doku", 6, 10, "link");
    expect(linked.next).toBe("siehe [Doku](https://)");
    expect(linked.selected).toBe("https://");
  });

  test("code is inline for a word and fenced for several lines", () => {
    expect(run("nutze subkit", 6, 12, "code").next).toBe("nutze `subkit`");
    expect(run("a\nb", 0, 3, "code").next).toBe("```\na\nb\n```");
  });

  test("a reference puts @ at the caret, with a space after a word", () => {
    const after = run("siehe", 5, 5, "reference");
    expect(after.next).toBe("siehe @");
    expect(after.edit.selection).toEqual({ from: 7, to: 7 });
    expect(run("", 0, 0, "reference").next).toBe("@");
  });

  test("a selection outside the text is clamped instead of throwing", () => {
    expect(run("kurz", 10, 2, "bold").next).toBe("ku**rz**");
  });
});
