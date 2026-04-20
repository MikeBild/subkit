// Unit tests for <HistorySearch> — the Ctrl-R prompt-ring pane.
// Verifies reverse-chronological rendering, arrow navigation,
// Enter selection, and type-to-filter.

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { HistorySearch } from "../HistorySearch.tsx";
import { ThemeProvider } from "../theme/Provider.tsx";

const ENTRIES = ["list connectors", "show status", "draft a webhook workflow"];

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms)); // allow-wall-clock: legacy; review before changing
}

describe("HistorySearch", () => {
  afterEach(() => cleanup());

  test("renders newest first and shows the full count", async () => {
    const instance = render(
      <ThemeProvider>
        <HistorySearch
          entries={ENTRIES}
          onSelect={() => {
            /* noop */
          }}
        />
      </ThemeProvider>,
    );
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("history");
    expect(frame).toContain("3 / 3");
    expect(frame).toContain("draft a webhook workflow");
    // Highlight marker is on the most-recent prompt.
    expect(frame).toMatch(/▶ draft a webhook workflow/);
    instance.unmount();
  });

  test("Enter picks the highlighted entry", async () => {
    const picked: { current: string | null } = { current: null };
    const instance = render(
      <ThemeProvider>
        <HistorySearch entries={ENTRIES} onSelect={(p) => (picked.current = p)} />
      </ThemeProvider>,
    );
    await tick();
    instance.stdin.write("\r");
    await tick(30);
    expect(picked.current).toBe("draft a webhook workflow");
    instance.unmount();
  });

  test("typing narrows the list to matching prompts", async () => {
    const instance = render(
      <ThemeProvider>
        <HistorySearch
          entries={ENTRIES}
          onSelect={() => {
            /* noop */
          }}
        />
      </ThemeProvider>,
    );
    await tick();
    instance.stdin.write("status");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("show status");
    expect(frame).not.toContain("list connectors");
    expect(frame).toContain("filter: status");
    instance.unmount();
  });

  test("Esc dismisses the pane", async () => {
    let dismissed = false;
    const instance = render(
      <ThemeProvider>
        <HistorySearch
          entries={ENTRIES}
          onSelect={() => {
            /* noop */
          }}
          onDismiss={() => {
            dismissed = true;
          }}
        />
      </ThemeProvider>,
    );
    await tick();
    instance.stdin.write("\u001b");
    await tick(30);
    expect(dismissed).toBe(true);
    instance.unmount();
  });
});
