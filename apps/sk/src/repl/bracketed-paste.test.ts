// Unit tests for the bracketed-paste state machine. We test the pure
// function so test runs don't need a real stdin.

import { describe, expect, it } from "bun:test";
import { applyBracketedPaste, PASTE_END, PASTE_START } from "./bracketed-paste.ts";

const empty = { inPaste: false, pasteBuf: "" };

describe("applyBracketedPaste", () => {
  it("passes normal input through unchanged", () => {
    const r = applyBracketedPaste("hello", empty);
    expect(r.keep.forward).toBe("hello");
    expect(r.keep.pending).toBe("");
    expect(r.events.emit).toEqual([]);
    expect(r.events.inPaste).toBe(false);
  });

  it("extracts a complete bracketed paste", () => {
    const input = `pre${PASTE_START}multi\nline${PASTE_END}post`;
    const r = applyBracketedPaste(input, empty);
    expect(r.events.emit).toEqual(["multi\nline"]);
    expect(r.keep.forward).toBe("prepost");
    expect(r.keep.pending).toBe("");
    expect(r.events.inPaste).toBe(false);
  });

  it("buffers a paste that spans two chunks", () => {
    const first = `${PASTE_START}one\n`;
    const a = applyBracketedPaste(first, empty);
    expect(a.events.emit).toEqual([]);
    expect(a.events.inPaste).toBe(true);
    expect(a.events.pasteBuf).toBe("one\n");
    expect(a.keep.pending).toBe("");

    const second = `two${PASTE_END}rest`;
    const b = applyBracketedPaste(second, {
      inPaste: a.events.inPaste,
      pasteBuf: a.events.pasteBuf,
    });
    expect(b.events.emit).toEqual(["one\ntwo"]);
    expect(b.keep.forward).toBe("rest");
    expect(b.events.inPaste).toBe(false);
  });

  it("retains a suspicious ESC prefix that may be the start of a marker", () => {
    // Raw ESC byte but no `[`, could start PASTE_START / PASTE_END.
    const r = applyBracketedPaste("tail\x1b", empty);
    expect(r.keep.forward).toBe("tail");
    expect(r.keep.pending).toBe("\x1b");
  });

  it("emits an empty paste when START/END arrive adjacent", () => {
    const r = applyBracketedPaste(`a${PASTE_START}${PASTE_END}b`, empty);
    expect(r.events.emit).toEqual([""]);
    expect(r.keep.forward).toBe("ab");
  });
});
