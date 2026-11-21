import { describe, expect, test } from "bun:test";
import {
  type RedactionInput,
  redactionPlan,
  SHADOW_TOLERANCE_PX,
  toImageRects,
} from "./computer-redaction.ts";
import type { RawNode } from "./computer-tree.ts";

const WINDOW = { x: 100, y: 200, width: 400, height: 300 };

const SECURE: RawNode = {
  role: "textfield",
  name: "Password",
  states: ["secure"],
  bounds: { x: 110, y: 220, width: 100, height: 20 },
};

function input(overrides: Partial<RedactionInput> = {}): RedactionInput {
  return {
    tree: { role: "window", bounds: WINDOW, children: [SECURE] },
    window: WINDOW,
    image: { width: 800, height: 600 },
    scale: 2,
    ...overrides,
  };
}

describe("toImageRects", () => {
  test("scales window points to image pixels", () => {
    expect(
      toImageRects(
        [{ x: 8, y: 18, width: 104, height: 24 }],
        WINDOW,
        { width: 800, height: 600 },
        2,
      ),
    ).toEqual([{ x: 16, y: 36, width: 208, height: 48 }]);
  });

  test("spreads each rectangle over the shadow margin, because the offset is unknown", () => {
    expect(
      toImageRects(
        [{ x: 8, y: 18, width: 104, height: 24 }],
        WINDOW,
        { width: 840, height: 640 },
        2,
      ),
    ).toEqual([{ x: 16, y: 36, width: 248, height: 88 }]);
    expect(
      toImageRects(
        [{ x: 0, y: 0, width: 10, height: 10 }],
        WINDOW,
        { width: 800.5, height: 600.5 },
        2,
      ),
    ).toEqual([{ x: 0, y: 0, width: 21, height: 21 }]);
  });

  test("clips to the image and drops empty rectangles", () => {
    expect(
      toImageRects(
        [{ x: 390, y: 290, width: 50, height: 50 }],
        WINDOW,
        { width: 800, height: 600 },
        2,
      ),
    ).toEqual([{ x: 780, y: 580, width: 20, height: 20 }]);
    expect(
      toImageRects(
        [{ x: -5, y: -5, width: 10, height: 10 }],
        WINDOW,
        { width: 800, height: 600 },
        2,
      ),
    ).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
    expect(
      toImageRects(
        [{ x: 500, y: 0, width: 10, height: 10 }],
        WINDOW,
        { width: 800, height: 600 },
        2,
      ),
    ).toEqual([]);
    expect(
      toImageRects(
        [{ x: 0, y: 400, width: 10, height: 10 }],
        WINDOW,
        { width: 800, height: 600 },
        2,
      ),
    ).toEqual([]);
  });

  test("rounds outward", () => {
    expect(
      toImageRects(
        [{ x: 1.3, y: 1.3, width: 1.3, height: 1.3 }],
        WINDOW,
        { width: 400, height: 300 },
        1,
      ),
    ).toEqual([{ x: 1, y: 1, width: 2, height: 2 }]);
  });

  test("an image smaller than the window does not match it", () => {
    expect(toImageRects([], WINDOW, { width: 800 - SHADOW_TOLERANCE_PX, height: 600 }, 2)).toEqual(
      [],
    );
    expect(
      toImageRects([], WINDOW, { width: 800 - SHADOW_TOLERANCE_PX - 1, height: 600 }, 2),
    ).toBeNull();
    expect(
      toImageRects([], WINDOW, { width: 800, height: 600 - SHADOW_TOLERANCE_PX - 1 }, 2),
    ).toBeNull();
  });

  test("refuses a scale that is not positive and finite", () => {
    expect(toImageRects([], WINDOW, { width: 800, height: 600 }, 0)).toBeNull();
    expect(toImageRects([], WINDOW, { width: 800, height: 600 }, -1)).toBeNull();
    expect(toImageRects([], WINDOW, { width: 800, height: 600 }, Number.NaN)).toBeNull();
    expect(
      toImageRects([], WINDOW, { width: 800, height: 600 }, Number.POSITIVE_INFINITY),
    ).toBeNull();
  });
});

describe("redactionPlan", () => {
  test("blacks out secure fields in image pixels", () => {
    expect(redactionPlan(input())).toEqual({
      ok: true,
      rects: [{ x: 16, y: 36, width: 208, height: 48 }],
    });
  });

  test("refuses while a secure field has focus", () => {
    const focused = { role: "window", children: [{ ...SECURE, states: ["secure", "focused"] }] };
    expect(redactionPlan(input({ tree: focused }))).toEqual({ ok: false, code: "secure_focus" });
  });

  test("refuses a secure field without bounds", () => {
    const { bounds: _bounds, ...unbounded } = SECURE;
    expect(redactionPlan(input({ tree: { role: "window", children: [unbounded] } }))).toEqual({
      ok: false,
      code: "secure_focus",
    });
  });

  test("an image that does not fit the window is stale", () => {
    expect(redactionPlan(input({ image: { width: 10, height: 10 } }))).toEqual({
      ok: false,
      code: "stale",
    });
  });

  test("a window without secure fields needs no rectangles", () => {
    expect(redactionPlan(input({ tree: { role: "window" } }))).toEqual({ ok: true, rects: [] });
  });
});

describe("image rectangle edges", () => {
  test("a height short by exactly the tolerance still fits", () => {
    expect(toImageRects([], WINDOW, { width: 800, height: 600 - SHADOW_TOLERANCE_PX }, 2)).toEqual(
      [],
    );
  });

  test("rectangles that end on the image edge are dropped", () => {
    expect(
      toImageRects(
        [{ x: 400, y: 0, width: 10, height: 10 }],
        WINDOW,
        { width: 800, height: 600 },
        2,
      ),
    ).toEqual([]);
    expect(
      toImageRects(
        [{ x: 0, y: 300, width: 10, height: 10 }],
        WINDOW,
        { width: 800, height: 600 },
        2,
      ),
    ).toEqual([]);
  });
});
