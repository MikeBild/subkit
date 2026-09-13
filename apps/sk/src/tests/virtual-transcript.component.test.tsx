import { ThemeProvider } from "@chat-ui/index.ts";
import { describe, expect, test } from "bun:test";
import { Text } from "ink";

import { HeightCache } from "../repl/transcript/height-cache.ts";
import {
  _computeSliceForTests as computeSlice,
  VirtualTranscript,
} from "../shell/VirtualTranscript.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

interface Msg {
  id: string;
  text: string;
  height: number;
}

describe("computeSlice", () => {
  test("returns empty when items is empty", () => {
    expect(computeSlice([], 10, { stickyBottom: true })).toEqual({ start: 0, end: 0 });
  });

  test("sticky-bottom keeps the most recent fitting items", () => {
    const heights = [3, 3, 3, 3, 3];
    const { start, end } = computeSlice(heights, 7, { stickyBottom: true });
    expect(end).toBe(5);
    expect(start).toBe(3);
  });

  test("sticky-bottom always renders at least the last item", () => {
    const { start, end } = computeSlice([100], 5, { stickyBottom: true });
    expect(start).toBe(0);
    expect(end).toBe(1);
  });

  test("non-sticky honors scrollTop and walks forward", () => {
    const heights = [2, 2, 2, 2, 2];
    expect(computeSlice(heights, 4, { stickyBottom: false, scrollTop: 0 })).toEqual({
      start: 0,
      end: 2,
    });
    expect(computeSlice(heights, 4, { stickyBottom: false, scrollTop: 2 })).toEqual({
      start: 2,
      end: 4,
    });
  });
});

describe("<VirtualTranscript>", () => {
  const renderItem = (m: Msg) => <Text>{m.text}</Text>;
  const getKey = (m: Msg) => m.id;
  const estimateHeight = (m: Msg) => m.height;

  test("renders items inside the viewport", async () => {
    const items: Msg[] = [
      { id: "a", text: "ALPHA", height: 1 },
      { id: "b", text: "BETA", height: 1 },
      { id: "c", text: "GAMMA", height: 1 },
    ];
    const ui = renderInk(
      <ThemeProvider>
        <VirtualTranscript
          items={items}
          getKey={getKey}
          estimateHeight={estimateHeight}
          renderItem={renderItem}
          viewportHeight={10}
          width={80}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("ALPHA");
      expect(ui.text()).toContain("BETA");
      expect(ui.text()).toContain("GAMMA");
    } finally {
      ui.unmount();
    }
  });

  test("sticky-bottom drops oldest items that overflow the viewport", async () => {
    const items: Msg[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      text: `MSG${i}`,
      height: 3,
    }));
    const ui = renderInk(
      <ThemeProvider>
        <VirtualTranscript
          items={items}
          getKey={getKey}
          estimateHeight={estimateHeight}
          renderItem={renderItem}
          viewportHeight={7}
          width={80}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("MSG4");
      expect(text).toContain("MSG3");
      // Only the last two should fit (3 + 3 = 6 ≤ 7); MSG0 and MSG1 dropped.
      expect(text).not.toContain("MSG0");
      expect(text).not.toContain("MSG1");
    } finally {
      ui.unmount();
    }
  });

  test("cache reuses heights for identical (key, width) pairs", async () => {
    const cache = new HeightCache();
    let estimateCalls = 0;
    const items: Msg[] = [
      { id: "a", text: "alpha", height: 1 },
      { id: "b", text: "beta", height: 1 },
    ];
    const counted = (m: Msg, _w: number): number => {
      estimateCalls++;
      return estimateHeight(m);
    };
    const ui = renderInk(
      <ThemeProvider>
        <VirtualTranscript
          items={items}
          getKey={getKey}
          estimateHeight={counted}
          renderItem={renderItem}
          viewportHeight={10}
          width={80}
          cache={cache}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const initialCalls = estimateCalls;
      // Force a re-render by remounting; with the same cache + width
      // we should hit, not miss.
      ui.unmount();
      const ui2 = renderInk(
        <ThemeProvider>
          <VirtualTranscript
            items={items}
            getKey={getKey}
            estimateHeight={counted}
            renderItem={renderItem}
            viewportHeight={10}
            width={80}
            cache={cache}
          />
        </ThemeProvider>,
      );
      try {
        await flush();
        expect(estimateCalls).toBe(initialCalls);
      } finally {
        ui2.unmount();
      }
    } finally {
      // already unmounted above
    }
  });

  test("changing width invalidates the cache (re-measure)", async () => {
    const cache = new HeightCache();
    const items: Msg[] = [{ id: "a", text: "alpha", height: 2 }];
    let calls = 0;
    const counted = (m: Msg, _w: number): number => {
      calls++;
      return estimateHeight(m);
    };
    const ui = renderInk(
      <ThemeProvider>
        <VirtualTranscript
          items={items}
          getKey={getKey}
          estimateHeight={counted}
          renderItem={renderItem}
          viewportHeight={10}
          width={80}
          cache={cache}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const before = calls;
      ui.unmount();
      const ui2 = renderInk(
        <ThemeProvider>
          <VirtualTranscript
            items={items}
            getKey={getKey}
            estimateHeight={counted}
            renderItem={renderItem}
            viewportHeight={10}
            width={120}
            cache={cache}
          />
        </ThemeProvider>,
      );
      try {
        await flush();
        expect(calls).toBeGreaterThan(before);
      } finally {
        ui2.unmount();
      }
    } finally {
      // already unmounted
    }
  });
});
