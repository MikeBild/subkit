// Unit tests for <ConversationBrowser> — the `/resume` modal. Checks
// list rendering, arrow-key navigation, Enter selection, and type-to-
// filter. Mirrors the keyboard contract described in the component's
// footer hint.

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { ConversationBrowser, type ConversationItem } from "../ConversationBrowser.tsx";
import { ThemeProvider } from "../theme/Provider.tsx";

const ITEMS: ConversationItem[] = [
  { id: "c-aaaaaaaa-0000", title: "invoice digest", updated_at: "2026-04-17T14:00:00Z" },
  { id: "c-bbbbbbbb-1111", title: "hubspot export", updated_at: "2026-04-16T09:30:00Z" },
  { id: "c-cccccccc-2222", title: null, updated_at: "2026-04-15T08:00:00Z" },
];

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("ConversationBrowser", () => {
  afterEach(() => cleanup());

  test("lists every item with title + updated_at", async () => {
    const instance = render(
      <ThemeProvider>
        <ConversationBrowser
          items={ITEMS}
          onSelect={() => {
            /* noop */
          }}
        />
      </ThemeProvider>,
    );
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("invoice digest");
    expect(frame).toContain("hubspot export");
    expect(frame).toContain("2026-04-17 14:00");
    expect(frame).toContain("3 / 3");
    instance.unmount();
  });

  test("Enter on the highlighted row invokes onSelect with its id", async () => {
    const picked: { current: string | null } = { current: null };
    const instance = render(
      <ThemeProvider>
        <ConversationBrowser items={ITEMS} onSelect={(id) => (picked.current = id)} />
      </ThemeProvider>,
    );
    await tick();
    instance.stdin.write("\r");
    await tick(30);
    expect(picked.current).toBe("c-aaaaaaaa-0000");
    instance.unmount();
  });

  test("ArrowDown moves the selection to the next row", async () => {
    const picked: { current: string | null } = { current: null };
    const instance = render(
      <ThemeProvider>
        <ConversationBrowser items={ITEMS} onSelect={(id) => (picked.current = id)} />
      </ThemeProvider>,
    );
    await tick();
    // Ink-testing-library passes DOWN as CSI B.
    instance.stdin.write("\u001b[B");
    await tick(20);
    instance.stdin.write("\r");
    await tick(30);
    expect(picked.current).toBe("c-bbbbbbbb-1111");
    instance.unmount();
  });

  test("typing filters the list by title substring", async () => {
    const instance = render(
      <ThemeProvider>
        <ConversationBrowser
          items={ITEMS}
          onSelect={() => {
            /* noop */
          }}
        />
      </ThemeProvider>,
    );
    await tick();
    instance.stdin.write("hub");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("hubspot export");
    expect(frame).not.toContain("invoice digest");
    expect(frame).toContain("filter: hub");
    instance.unmount();
  });
});
