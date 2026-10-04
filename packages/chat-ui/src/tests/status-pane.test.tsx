import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { StatusPane } from "../StatusPane.tsx";
import { ThemeProvider } from "../theme/Provider.tsx";

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms)); // allow-wall-clock: Ink renderer settle window after a status update
}

describe("StatusPane", () => {
  afterEach(() => cleanup());

  test("renders title, subtitle and aligned rows", async () => {
    const instance = render(
      <ThemeProvider>
        <StatusPane
          title="status"
          subtitle="default"
          rows={[
            ["user", "user@example.com"],
            ["tenant", "tenant-alpha"],
            ["connectors", 7],
            ["tokens · today", 128],
          ]}
        />
      </ThemeProvider>,
    );
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("status");
    expect(frame).toContain("default");
    expect(frame).toContain("user@example.com");
    expect(frame).toContain("tenant-alpha");
    expect(frame).toContain("7");
    expect(frame).toContain("128");
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("empty, null and undefined values render as em-dash", async () => {
    const instance = render(
      <ThemeProvider>
        <StatusPane
          rows={[
            ["one", ""],
            ["two", null],
            ["three", undefined],
          ]}
        />
      </ThemeProvider>,
    );
    await tick();
    const frame = instance.lastFrame() ?? "";
    const dashes = (frame.match(/—/g) ?? []).length;
    expect(dashes).toBeGreaterThanOrEqual(3);
    instance.unmount();
  });

  test("Esc calls onDismiss", async () => {
    let dismissed = false;
    const instance = render(
      <ThemeProvider>
        <StatusPane rows={[["a", "b"]]} onDismiss={() => (dismissed = true)} />
      </ThemeProvider>,
    );
    await tick();
    instance.stdin.write("\u001b");
    await tick(30);
    expect(dismissed).toBe(true);
    instance.unmount();
  });
});
