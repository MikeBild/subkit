// Unit tests for the ScrollView primitive — windowing, auto-pin,
// keyboard scrolling. Lives in @chat-ui because multiple `sk`
// surfaces consume it.

import { afterEach, describe, expect, test } from "bun:test";
import { Text } from "ink";
import { cleanup, render } from "ink-testing-library";
import { ScrollView } from "../ScrollView.tsx";
import { ThemeProvider } from "../theme/Provider.tsx";

function rows(n: number): React.ReactElement[] {
  const out: React.ReactElement[] = [];
  for (let i = 0; i < n; i++)
    out.push(<Text key={`r-${i}`}>row-{String(i).padStart(3, "0")}</Text>);
  return out;
}

function mount(children: React.ReactNode, height = 5): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ScrollView height={height}>{children}</ScrollView>
    </ThemeProvider>,
  );
}

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms)); // allow-wall-clock: legacy; review before changing
}

describe("ScrollView", () => {
  afterEach(() => cleanup());

  test("windows history to viewport height and pins to the tail", async () => {
    const instance = mount(rows(20), 5);
    await tick();
    const frame = instance.lastFrame() ?? "";
    // With 20 rows and a 5-row viewport, auto-pin shows rows 15..19.
    expect(frame).toContain("row-019");
    expect(frame).toContain("row-015");
    expect(frame).not.toContain("row-000");
    expect(frame).toContain("more above");
    instance.unmount();
  });

  test("renders the empty-label fallback when there are no children", async () => {
    const instance = render(
      <ThemeProvider>
        <ScrollView height={5} emptyLabel="no rows yet">
          {null}
        </ScrollView>
      </ThemeProvider>,
    );
    await tick();
    expect(instance.lastFrame() ?? "").toContain("no rows yet");
    instance.unmount();
  });

  test("PgUp scrolls back a viewport height", async () => {
    const instance = mount(rows(20), 5);
    await tick();
    // PgUp = 0x1b 0x5b 0x35 0x7e (CSI 5~). Ink's parser handles it.
    instance.stdin.write("\u001b[5~");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    // After one PgUp (jump = viewport - 1 = 4) from offset 15 → offset 11.
    // Rows shown: 11..15.
    expect(frame).toContain("row-011");
    expect(frame).toContain("row-015");
    expect(frame).toContain("more below");
    instance.unmount();
  });
});
