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

async function tick(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms)); // allow-wall-clock
}

describe("ScrollView", () => {
  afterEach(() => cleanup());

  test("windows history to viewport height and pins to the tail", async () => {
    const instance = mount(rows(20), 5);
    await tick();
    const frame = instance.lastFrame() ?? "";
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
    instance.stdin.write("\u001b[5~");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("row-011");
    expect(frame).toContain("row-015");
    expect(frame).toContain("more below");
    instance.unmount();
  });
});
