import { describe, expect, test } from "bun:test";
import {
  browserSnapshotElements,
  computerTreeElements,
  ElementTargetSchema,
  needsFreshSnapshot,
  pickElement,
} from "./element-target.ts";

describe("element target schema", () => {
  test("takes role, name and an optional nth, nothing else", () => {
    expect(ElementTargetSchema.parse({ role: " button ", name: "Send" })).toEqual({
      role: "button",
      name: "Send",
    });
    expect(ElementTargetSchema.parse({ role: "link", name: "", nth: 99 }).nth).toBe(99);
    for (const bad of [
      { role: "", name: "x" },
      { role: "   ", name: "x" },
      { role: "r".repeat(65), name: "x" },
      { role: "button", name: "n".repeat(501) },
      { role: "button", name: "x", nth: -1 },
      { role: "button", name: "x", nth: 100 },
      { role: "button", name: "x", nth: 1.5 },
      { role: "button", name: "x", ref: "e1" },
    ])
      expect(ElementTargetSchema.safeParse(bad).success).toBe(false);
    expect(
      ElementTargetSchema.safeParse({ role: "r".repeat(64), name: "n".repeat(500) }).success,
    ).toBe(true);
  });
});

describe("browser snapshot elements", () => {
  test("reads the refs map of an agent-browser snapshot", () => {
    const output = {
      snapshot: {
        snapshot: '- button "ignored" [ref=e9]',
        refs: {
          e1: { role: "button", name: "Buy" },
          e12: { role: "link" },
          xe1: { role: "button", name: "x" },
          e1x: { role: "button", name: "x" },
          e3: { name: "no role" },
          bad: { role: "button", name: "x" },
          e4: "not an object",
          e5: null,
          e6: ["button"],
        },
      },
    };
    expect(browserSnapshotElements(output)).toEqual([
      { ref: "e1", role: "button", name: "Buy" },
      { ref: "e12", role: "link", name: "" },
    ]);
  });

  test("falls back to the text tree when the refs carry no roles", () => {
    const text = [
      '- heading "Invoices" [level=1, ref=e1]',
      '  - button "Say \\"hi\\"" [ref=e22]',
      "  - textbox [ref=e3]",
      "  - generic",
      '- link "x" [ref=f4]',
      'button "no dash" [ref=e5]',
      'x - button "inner dash" [ref=e6]',
      '-  button "Two spaces" [ref=e7]',
      '- button  "Spaced" [ref=e8]',
    ].join("\n");
    const expected = [
      { ref: "e1", role: "heading", name: "Invoices" },
      { ref: "e22", role: "button", name: 'Say "hi"' },
      { ref: "e3", role: "textbox", name: "" },
      { ref: "e7", role: "button", name: "Two spaces" },
      { ref: "e8", role: "button", name: "Spaced" },
    ];
    expect(browserSnapshotElements({ snapshot: { snapshot: text, refs: { e1: {} } } })).toEqual(
      expected,
    );
    expect(browserSnapshotElements({ snapshot: { snapshot: text } })).toEqual(expected);
    expect(browserSnapshotElements({ snapshot: text })).toEqual(expected);
    expect(browserSnapshotElements(text)).toEqual(expected);
  });

  test("an unknown shape has no elements", () => {
    expect(browserSnapshotElements(null)).toEqual([]);
    expect(browserSnapshotElements({ snapshot: 5 })).toEqual([]);
    expect(browserSnapshotElements({ snapshot: { refs: [] } })).toEqual([]);
    expect(browserSnapshotElements({ snapshot: { snapshot: 7 } })).toEqual([]);
    expect(browserSnapshotElements([])).toEqual([]);
  });
});

describe("computer tree elements", () => {
  test("walks the whole tree and keeps nodes with a ref and a role", () => {
    const tree = {
      role: "window",
      name: "Numbers",
      children: [
        { role: "button", name: "Save", ref: "@s1:e1" },
        { role: "password", name: "[password, hidden]" },
        {
          role: "group",
          ref: "@s1:e2",
          children: [{ role: "cell", name: "A1", ref: "@s1:e3" }, "noise", null],
        },
        { ref: "@s1:e4", name: "no role" },
      ],
    };
    expect(computerTreeElements(tree)).toEqual([
      { ref: "@s1:e1", role: "button", name: "Save" },
      { ref: "@s1:e2", role: "group", name: "" },
      { ref: "@s1:e3", role: "cell", name: "A1" },
    ]);
    expect(computerTreeElements({ role: "window", ref: "@s1:e9", children: "x" })).toEqual([
      { ref: "@s1:e9", role: "window", name: "" },
    ]);
    expect(computerTreeElements(undefined)).toEqual([]);
  });
});

describe("pick element", () => {
  const entries = [
    { ref: "e1", role: "button", name: "Send" },
    { ref: "e2", role: "Button", name: "  Send  now " },
    { ref: "e3", role: "button", name: "Send now" },
    { ref: "e4", role: "link", name: "Send" },
    { ref: "e5", role: "button", name: "Sendnow" },
  ];

  test("matches role case-insensitively and the name with normalized spaces", () => {
    expect(pickElement(entries, { role: " BUTTON ", name: "Send" })).toEqual({
      ok: true,
      ref: "e1",
    });
    expect(pickElement(entries, { role: "link", name: " Send " })).toEqual({ ok: true, ref: "e4" });
  });

  test("several matches need nth, none is not found", () => {
    expect(pickElement(entries, { role: "button", name: "Send now" })).toEqual({
      ok: false,
      code: "element_ambiguous",
      matches: 2,
    });
    expect(pickElement(entries, { role: "button", name: "Send now", nth: 1 })).toEqual({
      ok: true,
      ref: "e3",
    });
    expect(pickElement(entries, { role: "button", name: "Send now", nth: 0 })).toEqual({
      ok: true,
      ref: "e2",
    });
    expect(pickElement(entries, { role: "button", name: "Send now", nth: 2 })).toEqual({
      ok: false,
      code: "element_not_found",
      matches: 2,
    });
    expect(pickElement(entries, { role: "checkbox", name: "Send" })).toEqual({
      ok: false,
      code: "element_not_found",
      matches: 0,
    });
  });
});

describe("fresh snapshot contract", () => {
  test("every ref action asks for a snapshot taken right before it", () => {
    for (const kind of [
      "computer.press",
      "computer.focus",
      "computer.select",
      "computer.set_value",
      "computer.type",
      "computer.scroll",
    ])
      expect(needsFreshSnapshot(kind, {})).toBe(true);
    expect(needsFreshSnapshot("browser.press", { action: "click", ref: "e1" })).toBe(true);
    expect(needsFreshSnapshot("browser.fill", { ref: "e1" })).toBe(true);
    expect(needsFreshSnapshot("browser.extract", {})).toBe(false);
    expect(needsFreshSnapshot("browser.press", { action: "key", key: "Enter" })).toBe(false);
    expect(needsFreshSnapshot("browser.press", null)).toBe(false);
    expect(needsFreshSnapshot("computer.key", { ref: "x" })).toBe(false);
    expect(needsFreshSnapshot("files.read_text", { ref: "e1" })).toBe(false);
  });
});
