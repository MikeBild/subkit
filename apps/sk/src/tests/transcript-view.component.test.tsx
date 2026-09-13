import { ThemeProvider } from "@chat-ui/index.ts";
import { describe, expect, test } from "bun:test";
import { Text } from "ink";

import { type TranscriptItem, TranscriptView } from "../repl/transcript/TranscriptView.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

const items = (n: number): TranscriptItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`,
    estimatedHeight: 1,
    node: <Text>row-{i}</Text>,
  }));

describe("<TranscriptView>", () => {
  test("renders empty when no items", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <TranscriptView items={[]} viewportHeight={10} width={80} />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text().trim()).toBe("");
    } finally {
      ui.unmount();
    }
  });

  test("renders all items when they fit the viewport", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <TranscriptView items={items(5)} viewportHeight={10} width={80} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      for (let i = 0; i < 5; i++) {
        expect(text).toContain(`row-${i}`);
      }
    } finally {
      ui.unmount();
    }
  });

  test("sticky-bottom drops oldest items when overflowing", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <TranscriptView items={items(20)} viewportHeight={5} width={80} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("row-19");
      expect(text).not.toContain("row-0");
    } finally {
      ui.unmount();
    }
  });
});
