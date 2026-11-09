import { expect, test } from "bun:test";
import { parseRenderableMessageContent as parse } from "./message-parts.ts";

test("structured text containers flatten in order and empty envelopes stay safe", () => {
  expect(
    parse({ parts: [{ text: "first" }, { content: [{ text: "second" }, { content: "third" }] }] }),
  ).toEqual({
    text: "first\n\nsecond\n\nthird",
    parts: [{ type: "text", text: "first\n\nsecond\n\nthird" }],
  });
  for (const value of [null, undefined, "", [], {}])
    expect(parse(value)).toEqual({ text: "", parts: [] });
  expect(parse({ text: "" }).text).toBe('{"text":""}');
  expect(parse({ content: "" }).text).toBe('{"content":""}');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(parse(circular)).toEqual({
    text: "[object Object]",
    parts: [{ type: "text", text: "[object Object]" }],
  });
});

test("fenced code preserves its body and language while prose keeps order", () => {
  const text = "before\n\n```ts\nconst x = 1;\n\n```\nafter\n```\nplain\n```";
  expect(parse(text)).toEqual({
    text,
    parts: [
      { type: "text", text: "before" },
      { type: "code_block", code: "const x = 1;", language: "ts" },
      { type: "text", text: "after" },
      { type: "code_block", code: "plain" },
    ],
  });
  expect(parse("```js\nnot closed").parts).toEqual([{ type: "text", text: "```js\nnot closed" }]);
  expect(parse("```\n```").parts).toEqual([{ type: "code_block", code: "" }]);
  expect(parse(" \n ").parts).toEqual([{ type: "text", text: " \n " }]);
});

test("tables normalize short and long rows and stop at following prose", () => {
  const text =
    "intro\n| A | B |\n| :--- | ---: |\n| one | two |\n| short |\n| x | y | extra |\nend";
  expect(parse(text).parts).toEqual([
    { type: "text", text: "intro" },
    {
      type: "table",
      headers: ["A", "B"],
      rows: [
        ["one", "two"],
        ["short", ""],
        ["x", "y"],
      ],
    },
    { type: "text", text: "end" },
  ]);
  expect(parse("A | B\n--- | ---\nx | y").parts).toEqual([
    { type: "table", headers: ["A", "B"], rows: [["x", "y"]] },
  ]);
  expect(parse("A | B\n--- | ---").parts).toEqual([
    { type: "table", headers: ["A", "B"], rows: [] },
  ]);
  for (const invalid of ["A | B\n-- | ---", "A | B\n---", "A | B\n--- | --- | ---"])
    expect(parse(invalid).parts).toEqual([{ type: "text", text: invalid }]);
});
