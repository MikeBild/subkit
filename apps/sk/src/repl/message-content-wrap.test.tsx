import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { MessageContent } from "./message-content.tsx";

function snapshot(s: ReturnType<typeof render>): string {
  return (s.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

describe("MessageContent · width-aware wrapping", () => {
  test("respects explicit width — content lines do not exceed it", () => {
    const r = render(<MessageContent content={"word ".repeat(40).trim()} width={30} />);
    const frame = snapshot(r);
    const lines = frame.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
    r.unmount();
  });

  test("does not split words mid-character at the wrap boundary", () => {
    const r = render(<MessageContent content="prefix supercalifragilistic" width={24} />);
    const frame = snapshot(r);
    expect(frame).toContain("supercalifragilistic");
    expect(frame).not.toMatch(/supercalifragili\s+stic/);
    r.unmount();
  });

  test("ignores width below the safety floor (16) — falls back to natural wrap", () => {
    const r = render(<MessageContent content="hello world" width={4} />);
    const frame = snapshot(r);
    expect(frame).toContain("hello");
    expect(frame).toContain("world");
    r.unmount();
  });

  test("renders without a width prop", () => {
    const r = render(<MessageContent content="plain text" />);
    const frame = snapshot(r);
    expect(frame).toContain("plain text");
    r.unmount();
  });
});
