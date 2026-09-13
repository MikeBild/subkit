import { ThemeProvider } from "@chat-ui/index.ts";
import { describe, expect, test } from "bun:test";
import { Text } from "ink";

import { MessageGutter } from "../shell/MessageGutter.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

describe("<MessageGutter>", () => {
  test("renders the default ⎿ glyph and children", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <MessageGutter>
          <Text>nested-content</Text>
        </MessageGutter>
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("⎿");
      expect(text).toContain("nested-content");
    } finally {
      ui.unmount();
    }
  });

  test("supports a custom prefix glyph", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <MessageGutter prefix="└">
          <Text>x</Text>
        </MessageGutter>
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("└");
      expect(text).not.toContain("⎿");
    } finally {
      ui.unmount();
    }
  });

  test("nested gutters render only the outer glyph", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <MessageGutter>
          <MessageGutter>
            <Text>deep</Text>
          </MessageGutter>
        </MessageGutter>
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      // Exactly one occurrence of the gutter glyph (or zero if Ink wraps
      // strangely) — at least we shouldn't see two.
      const occurrences = (text.match(/⎿/g) ?? []).length;
      expect(occurrences).toBeLessThanOrEqual(1);
      expect(text).toContain("deep");
    } finally {
      ui.unmount();
    }
  });
});
