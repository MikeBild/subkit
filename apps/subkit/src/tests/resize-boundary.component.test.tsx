import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { Text } from "ink";
import { _sanitizeSizeForTests, ResizeBoundary } from "../shell/ResizeBoundary.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

describe("sanitizeSize", () => {
  test("zero cols/rows fall back to defaults (PTY emulator case)", () => {
    expect(_sanitizeSizeForTests({ cols: 0, rows: 0 }, { cols: 80, rows: 24 })).toEqual({
      cols: 80,
      rows: 24,
    });
  });

  test("undefined values fall back to defaults", () => {
    expect(_sanitizeSizeForTests({}, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(
      _sanitizeSizeForTests({ cols: undefined, rows: undefined }, { cols: 100, rows: 30 }),
    ).toEqual({ cols: 100, rows: 30 });
  });

  test("non-zero positive dimensions are honored", () => {
    expect(_sanitizeSizeForTests({ cols: 120, rows: 40 }, { cols: 80, rows: 24 })).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  test("zero cols + valid rows substitutes only cols", () => {
    expect(_sanitizeSizeForTests({ cols: 0, rows: 30 }, { cols: 80, rows: 24 })).toEqual({
      cols: 80,
      rows: 30,
    });
  });

  test("negative values fall back to defaults", () => {
    expect(_sanitizeSizeForTests({ cols: -5, rows: -1 }, { cols: 80, rows: 24 })).toEqual({
      cols: 80,
      rows: 24,
    });
  });
});

describe("<ResizeBoundary>", () => {
  test("renders children when terminal is large enough", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ResizeBoundary minCols={20} minRows={5}>
          <Text>HELLO</Text>
        </ResizeBoundary>
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("HELLO");
    } finally {
      ui.unmount();
    }
  });

  test("renders fallback skeleton when terminal is too small", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ResizeBoundary minCols={500} minRows={500}>
          <Text>HIDDEN</Text>
        </ResizeBoundary>
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("terminal too small");
      expect(text).not.toContain("HIDDEN");
    } finally {
      ui.unmount();
    }
  });

  test("debounce timer is cleared on unmount", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ResizeBoundary>
          <Text>X</Text>
        </ResizeBoundary>
      </ThemeProvider>,
    );
    await flush();
    expect(() => ui.unmount()).not.toThrow();
  });
});
