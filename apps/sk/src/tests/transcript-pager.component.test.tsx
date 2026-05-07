import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { type PagerEntry, TranscriptPager } from "../shell/TranscriptPager.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

const userEntry = (id: string, text: string): PagerEntry => ({
  id,
  kind: "user",
  text,
});

describe("<TranscriptPager>", () => {
  test("renders nothing when closed", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <TranscriptPager
          open={false}
          entries={[userEntry("a", "hello")]}
          onClose={() => undefined}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text().trim()).toBe("");
    } finally {
      ui.unmount();
    }
  });

  test("renders a header + the supplied user entries when open", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <TranscriptPager
          open={true}
          entries={[userEntry("a", "first"), userEntry("b", "second")]}
          onClose={() => undefined}
          rows={20}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("transcript pager");
      expect(text).toContain("2 entries");
      // VirtualTranscript renders rows; both should surface.
      expect(text).toContain("first");
      expect(text).toContain("second");
    } finally {
      ui.unmount();
    }
  });

  test("Esc fires onClose", async () => {
    let closed = false;
    const ui = renderInk(
      <ThemeProvider>
        <TranscriptPager
          open={true}
          entries={[userEntry("a", "row")]}
          onClose={() => {
            closed = true;
          }}
          rows={20}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      // Ink debounces ESC to disambiguate from escape sequences;
      // ui.waitFor's sleepMs opts into wall-clock progress.
      await ui.press("esc");
      await ui.waitFor(() => closed, { tries: 50, sleepMs: 10 });
      expect(closed).toBe(true);
    } finally {
      ui.unmount();
    }
  });
});
