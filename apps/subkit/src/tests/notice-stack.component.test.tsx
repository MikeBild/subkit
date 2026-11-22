import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { type NoticeItem, NoticeStack } from "../shell/NoticeStack.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

const item = (overrides: Partial<NoticeItem>): NoticeItem => ({
  id: overrides.id ?? "n1",
  tone: overrides.tone ?? "info",
  message: overrides.message ?? "hello",
  persistent: overrides.persistent ?? false,
  ...overrides,
});

describe("<NoticeStack>", () => {
  test("renders nothing when empty", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <NoticeStack items={[]} />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text().trim()).toBe("");
    } finally {
      ui.unmount();
    }
  });

  test("renders the message text for each item", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <NoticeStack
          items={[item({ id: "a", message: "alpha-msg" }), item({ id: "b", message: "bravo-msg" })]}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("alpha-msg");
      expect(text).toContain("bravo-msg");
    } finally {
      ui.unmount();
    }
  });

  test("renders error tone differently from info tone", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <NoticeStack
          items={[
            item({ id: "i", tone: "info", message: "info-row" }),
            item({ id: "e", tone: "error", message: "error-row" }),
          ]}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("info-row");
      expect(text).toContain("error-row");
    } finally {
      ui.unmount();
    }
  });
});
