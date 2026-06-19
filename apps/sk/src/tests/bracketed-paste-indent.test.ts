import { describe, expect, test } from "bun:test";
import { applyBracketedPaste, PASTE_END, PASTE_START } from "../repl/bracketed-paste.ts";

const wrap = (s: string): string => `${PASTE_START}${s}${PASTE_END}`;

describe("applyBracketedPaste preserves indentation", () => {
  test("leading spaces and tabs survive verbatim", () => {
    const indented = "    function foo() {\n\treturn 42;\n}";
    const r = applyBracketedPaste(wrap(indented), { inPaste: false, pasteBuf: "" });
    expect(r.events.emit.length).toBe(1);
    expect(r.events.emit[0]).toBe(indented);
  });

  test("empty lines inside the paste are preserved", () => {
    const block = "alpha\n\nbeta\n  beta_indent";
    const r = applyBracketedPaste(wrap(block), { inPaste: false, pasteBuf: "" });
    expect(r.events.emit[0]).toBe(block);
  });

  test("trailing whitespace is preserved", () => {
    const block = "trailing   \nspaces  \t";
    const r = applyBracketedPaste(wrap(block), { inPaste: false, pasteBuf: "" });
    expect(r.events.emit[0]).toBe(block);
  });

  test("paste split across two stdin chunks reassembles correctly", () => {
    const part1 = `${PASTE_START}    if (x) {`;
    const part2 = `\n        return;\n    }${PASTE_END}`;
    const s1 = applyBracketedPaste(part1, { inPaste: false, pasteBuf: "" });
    expect(s1.events.emit.length).toBe(0);
    expect(s1.events.inPaste).toBe(true);
    const s2 = applyBracketedPaste(part2, s1.events);
    expect(s2.events.emit.length).toBe(1);
    expect(s2.events.emit[0]).toBe("    if (x) {\n        return;\n    }");
  });

  test("non-paste input flows through `forward` untouched", () => {
    const r = applyBracketedPaste("hello world", { inPaste: false, pasteBuf: "" });
    expect(r.keep.forward).toBe("hello world");
    expect(r.events.emit.length).toBe(0);
  });
});
