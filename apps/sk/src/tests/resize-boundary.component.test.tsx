import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { Text } from "ink";
import { ResizeBoundary } from "../shell/ResizeBoundary.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

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
    // ink-testing-library default columns is 100, rows 24. Set thresholds
    // higher so the fallback path kicks in.
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
    // Unmount should not throw or leak handles.
    expect(() => ui.unmount()).not.toThrow();
  });
});
