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

test("primitive and opaque payloads stay readable without inventing text segments", () => {
  expect(parse(0)).toEqual({ text: "0", parts: [{ type: "text", text: "0" }] });
  expect(parse(false)).toEqual({ text: "false", parts: [{ type: "text", text: "false" }] });
  expect(parse({ value: "kept as structured JSON" })).toEqual({
    text: '{"value":"kept as structured JSON"}',
    parts: [{ type: "text", text: '{"value":"kept as structured JSON"}' }],
  });
  expect(parse("prose\n\n\n\nmore prose").parts).toEqual([
    { type: "text", text: "prose\n\nmore prose" },
  ]);
});

test("message parsing distinguishes empty segments, delimiter shapes, and literal markdown", () => {
  expect(parse(["", { text: "" }, { content: "" }, 0, false])).toEqual({
    text: "0\n\nfalse",
    parts: [{ type: "text", text: "0\n\nfalse" }],
  });
  expect(parse([{}])).toEqual({ text: "[{}]", parts: [{ type: "text", text: "[{}]" }] });

  expect(parse("```ts trailing\nbody\n```").parts).toEqual([
    { type: "text", text: "```ts trailing\nbody\n```" },
  ]);
  expect(parse("before\n```c++\nline\n\n\n```\nafter").parts).toEqual([
    { type: "text", text: "before" },
    { type: "code_block", language: "c++", code: "line" },
    { type: "text", text: "after" },
  ]);
  expect(parse("```\nbody\n``` suffix").parts).toEqual([
    { type: "text", text: "```\nbody\n``` suffix" },
  ]);

  expect(parse("| left | right |\n| :---: | ---: |\n| one | two |").parts).toEqual([
    { type: "table", headers: ["left", "right"], rows: [["one", "two"]] },
  ]);
  for (const invalid of [
    "A | B\n| --- | ---x |\nx | y",
    "A | B\n| --- | --- | --- |\nx | y",
    "A | B\n| -- | --- |\nx | y",
  ])
    expect(parse(invalid).parts).toEqual([{ type: "text", text: invalid }]);
});

test("fences only recognize complete standalone markers and preserve multiline code", () => {
  expect(parse("prefix ```ts\nnot code\n```").parts).toEqual([
    { type: "text", text: "prefix ```ts\nnot code\n```" },
  ]);
  expect(parse("```ts\na\nb\n\n\n```").parts).toEqual([
    { type: "code_block", language: "ts", code: "a\nb" },
  ]);
  expect(parse("```ts\nbody\nx```\nrest").parts).toEqual([
    { type: "text", text: "```ts\nbody\nx```\nrest" },
  ]);
  expect(parse("  | A | B |  \n  | --- | --- |  \n  | x | y |  ").parts).toEqual([
    { type: "table", headers: ["A", "B"], rows: [["x", "y"]] },
  ]);
});

test("sparse arrays remain nonempty structured payloads", () => {
  const sparse = new Array(1);
  expect(parse(sparse)).toEqual({ text: "[null]", parts: [{ type: "text", text: "[null]" }] });
});

test("fence whitespace and table cell edges remain syntactically significant", () => {
  expect(parse("```ts \t\nbody\n``` \t").parts).toEqual([
    { type: "code_block", language: "ts", code: "body" },
  ]);
  expect(parse("A | B\nx--- | ---\nleft | right").parts).toEqual([
    { type: "text", text: "A | B\nx--- | ---\nleft | right" },
  ]);
  expect(parse("a|b|\n---|---|\nleft|right|").parts).toEqual([
    { type: "table", headers: ["a", "b"], rows: [["left", "right"]] },
  ]);
  expect(parse("A\n---\nvalue").parts).toEqual([{ type: "text", text: "A\n---\nvalue" }]);
});
