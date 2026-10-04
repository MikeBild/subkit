// Bug B regression: assistant prose in session 86de186b wrapped at
// full terminal width and continuation lines lost the speaker indent
// — words split mid-glyph ("transf\norm)") and the second line
// landed at col 0 instead of col 8. Post-fix MessageContent accepts
// an explicit `width` so Ink wraps within the indented body column.

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { MessageContent } from "./message-content.tsx";

function snapshot(s: ReturnType<typeof render>): string {
  return (s.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

describe("MessageContent · width-aware wrapping", () => {
  test("respects explicit width — content lines do not exceed it", () => {
    const r = render(<MessageContent content={"word ".repeat(40).trim()} width={30} />);
    const frame = snapshot(r);
    const lines = frame.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
    r.unmount();
  });

  test("does not split words mid-character at the wrap boundary", () => {
    // The single long word "supercalifragilistic" is 20 chars; with
    // width=24 it should fit on one line uncut.
    const r = render(<MessageContent content="prefix supercalifragilistic" width={24} />);
    const frame = snapshot(r);
    expect(frame).toContain("supercalifragilistic");
    // Ink's "wrap" mode is word-aware; partial matches like
    // "supercalifragili\nstic" must NOT appear.
    expect(frame).not.toMatch(/supercalifragili\s+stic/);
    r.unmount();
  });

  test("ignores width below the safety floor (16) — falls back to natural wrap", () => {
    // A pathologically tiny width should not produce an empty box.
    const r = render(<MessageContent content="hello world" width={4} />);
    const frame = snapshot(r);
    expect(frame).toContain("hello");
    expect(frame).toContain("world");
    r.unmount();
  });

  test("renders without a width prop", () => {
    const r = render(<MessageContent content="plain text" />);
    const frame = snapshot(r);
    expect(frame).toContain("plain text");
    r.unmount();
  });
});
