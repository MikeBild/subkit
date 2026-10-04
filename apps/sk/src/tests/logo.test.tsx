import { describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { LOGO_ROWS, LOGO_ROWS_APPLE, Logo } from "../repl/logo.tsx";

describe("sk Logo", () => {
  test("renders all three glyph rows on standard terminals", () => {
    const instance = render(<Logo />);
    const frame = instance.lastFrame() ?? "";
    for (const row of LOGO_ROWS) {
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
