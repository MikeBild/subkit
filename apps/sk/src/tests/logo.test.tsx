// Unit tests for the sk block-mark logo. Asserts on the rendered
// glyph rows (stable substrings) so cosmetic color tweaks don't
// require test churn — only a glyph change would.

import { describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";

import { Logo, LOGO_ROWS, LOGO_ROWS_APPLE } from "../repl/logo.tsx";

describe("sk Logo", () => {
  test("renders all three glyph rows on standard terminals", () => {
    const instance = render(<Logo />);
    const frame = instance.lastFrame() ?? "";
    for (const row of LOGO_ROWS) {
      // Trailing whitespace may be trimmed by Ink's writer — match the
      // non-whitespace portion so the assertion stays stable.
      const trimmed = row.trimEnd();
      if (trimmed.length === 0) continue;
      expect(frame).toContain(trimmed);
    }
    instance.unmount();
    cleanup();
  });

  test("renders the `sk` glyph characters (block shapes)", () => {
    const instance = render(<Logo />);
    const frame = instance.lastFrame() ?? "";
    // Distinct block characters used by the mark.
    expect(frame).toContain("▛");
    expect(frame).toContain("▜");
    expect(frame).toContain("▐");
    expect(frame).toContain("▖");
    instance.unmount();
    cleanup();
  });

  test("Apple Terminal fallback swaps row 3 to filled variants", () => {
    const instance = render(<Logo appleFallback={true} />);
    const frame = instance.lastFrame() ?? "";
    // Standard row 3 is spaces; Apple row 3 has decorative chars.
    const appleRow3 = LOGO_ROWS_APPLE[2]?.trimEnd() ?? "";
    expect(appleRow3.length).toBeGreaterThan(0);
    expect(frame).toContain(appleRow3);
    instance.unmount();
    cleanup();
  });

  test("LOGO_ROWS and LOGO_ROWS_APPLE share the first two rows", () => {
    expect(LOGO_ROWS[0]).toBe(LOGO_ROWS_APPLE[0]);
    expect(LOGO_ROWS[1]).toBe(LOGO_ROWS_APPLE[1]);
  });

  test("all rows have the same printable width", () => {
    const widths = LOGO_ROWS.map((r) => [...r].length);
    for (const w of widths) expect(w).toBe(widths[0] ?? 0);
  });
});
