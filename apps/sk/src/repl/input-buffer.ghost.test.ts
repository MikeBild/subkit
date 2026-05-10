import { describe, expect, test } from "bun:test";
import { apply, EMPTY_BUFFER } from "./input-buffer.ts";

describe("InputBuffer — ghost set", () => {
  test("attaches a ghost to an empty buffer", () => {
    const out = apply(EMPTY_BUFFER, { type: "ghostSet", text: "commit", kind: "text" });
    expect(out.ghost).toEqual({ text: "commit", consumed: 0, kind: "text" });
  });

  test("rejects a ghost when the buffer is already non-empty", () => {
    const seeded = apply(EMPTY_BUFFER, { type: "insert", text: "x" });
    const out = apply(seeded, { type: "ghostSet", text: "commit", kind: "text" });
    expect(out.ghost).toBeUndefined();
  });

  test("rejects an empty-text ghost", () => {
    const out = apply(EMPTY_BUFFER, { type: "ghostSet", text: "", kind: "text" });
    expect(out.ghost).toBeUndefined();
  });

  test("preserves slash kind on the ghost", () => {
    const out = apply(EMPTY_BUFFER, {
      type: "ghostSet",
      text: "/skill release-notes draft",
      kind: "slash",
    });
    expect(out.ghost?.kind).toBe("slash");
  });
});

describe("InputBuffer — type-to-accept", () => {
  const seeded = () => apply(EMPTY_BUFFER, { type: "ghostSet", text: "commit", kind: "text" });

  test("typing the matching prefix advances `consumed` and keeps the ghost", () => {
    let s = seeded();
    s = apply(s, { type: "insert", text: "c" });
    expect(s).toMatchObject({
      value: "c",
      cursor: 1,
      ghost: { text: "commit", consumed: 1, kind: "text" },
    });
    s = apply(s, { type: "insert", text: "o" });
    expect(s.ghost?.consumed).toBe(2);
    expect(s.value).toBe("co");
  });

  test("typing all the way to the end drops the ghost (typed-over)", () => {
    let s = seeded();
    for (const ch of "commit") {
      s = apply(s, { type: "insert", text: ch });
    }
    expect(s.value).toBe("commit");
    expect(s.ghost).toBeUndefined();
  });

  test("a divergent keystroke clears the ghost without losing the keystroke", () => {
    let s = seeded();
    s = apply(s, { type: "insert", text: "x" });
    expect(s.value).toBe("x");
    expect(s.ghost).toBeUndefined();
  });

  test("a paste (multi-char insert) always clears the ghost", () => {
    let s = seeded();
    s = apply(s, { type: "insert", text: "commit and push it" });
    expect(s.ghost).toBeUndefined();
    expect(s.value).toBe("commit and push it");
  });
});

describe("InputBuffer — accept / clear", () => {
  test("ghostAccept replaces the buffer with the full ghost text", () => {
    let s = apply(EMPTY_BUFFER, { type: "ghostSet", text: "commit it", kind: "text" });
    s = apply(s, { type: "ghostAccept" });
    expect(s).toEqual({ value: "commit it", cursor: 9 });
  });

  test("ghostAccept after partial typing still inserts the full ghost text", () => {
    let s = apply(EMPTY_BUFFER, { type: "ghostSet", text: "commit", kind: "text" });
    s = apply(s, { type: "insert", text: "c" });
    s = apply(s, { type: "insert", text: "o" });
    s = apply(s, { type: "ghostAccept" });
    expect(s.value).toBe("commit");
  });

  test("ghostAccept is a no-op without a ghost", () => {
    const s = apply(EMPTY_BUFFER, { type: "ghostAccept" });
    expect(s).toEqual(EMPTY_BUFFER);
  });

  test("ghostClear drops the hint without touching value/cursor", () => {
    let s = apply(EMPTY_BUFFER, { type: "ghostSet", text: "commit", kind: "text" });
    s = apply(s, { type: "ghostClear" });
    expect(s).toEqual({ value: "", cursor: 0 });
  });
});

describe("InputBuffer — invariant: ghost cannot survive divergent edits", () => {
  test("backspace drops the ghost mid-typing", () => {
    let s = apply(EMPTY_BUFFER, { type: "ghostSet", text: "commit", kind: "text" });
    s = apply(s, { type: "insert", text: "c" });
    expect(s.ghost?.consumed).toBe(1);
    s = apply(s, { type: "deletePrev" });
    expect(s.ghost).toBeUndefined();
    expect(s.value).toBe("");
  });

  test("moving the cursor away drops the ghost", () => {
    let s = apply(EMPTY_BUFFER, { type: "ghostSet", text: "commit", kind: "text" });
    s = apply(s, { type: "insert", text: "co" });
    s = apply(s, { type: "moveHome" });
    expect(s.ghost).toBeUndefined();
  });
});
