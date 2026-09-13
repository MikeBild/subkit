// sk.documentToMarkdown — document shapes behind ONE generic entry
// point (the vendor format — today Notion's blocks/rich_text wire
// format — is detected by shape, never named by the caller). The
// silent-loss incident class these pin: ad-hoc transforms over
// `results[].rich_text` drop every annotation (bold/links/code), and a
// hand-rolled block renderer returns "" for unhandled block types — the
// canonical "green run, lossy document" shape named in
// transform-warnings. Tests run inside the real QuickJS sandbox.

import { describe, expect, test } from "bun:test";

import { runJs } from "../../runtime.ts";

const run = <T>(code: string, input: unknown): Promise<T> =>
  runJs<T>({ code, input, clock: null }).then((r) => r.output as T);

const span = (
  content: string,
  annotations: Record<string, boolean> = {},
  link: string | null = null,
): Record<string, unknown> => ({
  type: "text",
  text: { content, link: link ? { url: link } : null },
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
    ...annotations,
  },
  plain_text: content,
  href: link,
});

describe("sk.documentToMarkdown — rich_text span arrays (inline markdown)", () => {
  test("annotations survive: bold, italic, strikethrough, code, links", async () => {
    const richText = [
      span("plain "),
      span("bold", { bold: true }),
      span(" and "),
      span("emphasized", { italic: true }),
      span(" and "),
      span("gone", { strikethrough: true }),
      span(" and "),
      span("inline()", { code: true }),
      span(" and a "),
      span("link", {}, "https://example.com/page"),
    ];
    const out = await run<string>("return sk.documentToMarkdown(input.rt);", {
      rt: richText,
    });
    expect(out).toBe(
      "plain **bold** and _emphasized_ and ~~gone~~ and `inline()` and a [link](https://example.com/page)",
    );
  });

  test("combined annotations nest (bold code link)", async () => {
    const out = await run<string>("return sk.documentToMarkdown(input.rt);", {
      rt: [span("api_key", { bold: true, code: true }, "https://example.com/docs")],
    });
    expect(out).toBe("[**`api_key`**](https://example.com/docs)");
  });

  test("non-array input throws — the generic surface never renders a green empty document", async () => {
    await expect(run("return sk.documentToMarkdown(input.rt);", { rt: null })).rejects.toThrow(
      /documentToMarkdown/,
    );
  });
});

describe("sk.documentToMarkdown — block arrays and blocks.children.list responses", () => {
  test("a blocks.children.list response renders headings, lists, todos, quote, code, divider", async () => {
    const response = {
      object: "list",
      results: [
        { object: "block", type: "heading_1", heading_1: { rich_text: [span("Title")] } },
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [span("Intro with "), span("bold", { bold: true })] },
        },
        {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [span("first bullet")] },
        },
        {
          object: "block",
          type: "numbered_list_item",
          numbered_list_item: { rich_text: [span("step one")] },
        },
        {
          object: "block",
          type: "numbered_list_item",
          numbered_list_item: { rich_text: [span("step two")] },
        },
        {
          object: "block",
          type: "to_do",
          to_do: { rich_text: [span("ship it")], checked: true },
        },
        { object: "block", type: "quote", quote: { rich_text: [span("a wise words")] } },
        {
          object: "block",
          type: "code",
          code: { rich_text: [span("return 42;")], language: "javascript" },
        },
        { object: "block", type: "divider", divider: {} },
      ],
      next_cursor: null,
      has_more: false,
    };
    const out = await run<string>("return sk.documentToMarkdown(input.blocks);", {
      blocks: response,
    });
    expect(out).toBe(
      [
        "# Title",
        "Intro with **bold**",
        "- first bullet",
        "1. step one",
        "2. step two",
        "- [x] ship it",
        "> a wise words",
        "```javascript\nreturn 42;\n```",
        "---",
      ].join("\n\n"),
    );
  });

  test("numbered list counters reset across interruptions", async () => {
    const blocks = [
      { type: "numbered_list_item", numbered_list_item: { rich_text: [span("one")] } },
      { type: "numbered_list_item", numbered_list_item: { rich_text: [span("two")] } },
      { type: "paragraph", paragraph: { rich_text: [span("break")] } },
      { type: "numbered_list_item", numbered_list_item: { rich_text: [span("restart")] } },
    ];
    const out = await run<string>("return sk.documentToMarkdown(input.blocks);", { blocks });
    expect(out).toBe(["1. one", "2. two", "break", "1. restart"].join("\n\n"));
  });

  test("an UNKNOWN block type degrades to its rich_text — never silently to empty", async () => {
    const blocks = [
      { type: "paragraph", paragraph: { rich_text: [span("kept")] } },
      { type: "callout", callout: { rich_text: [span("important note")], icon: { emoji: "!" } } },
    ];
    const out = await run<string>("return sk.documentToMarkdown(input.blocks);", { blocks });
    expect(out).toBe("kept\n\nimportant note");
  });

  test("non-block input throws instead of rendering a green empty document", async () => {
    await expect(
      run("return sk.documentToMarkdown(input.blocks);", { blocks: "nope" }),
    ).rejects.toThrow(/documentToMarkdown/);
  });
});
