import { describe, expect, test } from "bun:test";
import {
  type AxNode,
  isSecureNode,
  maskSecureNodes,
  REDACTION_PADDING,
  type Rect,
  redactRects,
  SCREENSHOT_MAX_EDGE,
  SECURE_PLACEHOLDER,
  scaleRects,
  screenshotPolicy,
  screenshotSize,
  secureFocus,
} from "./redaction-rects.ts";

const WINDOW = { x: 100, y: 50, width: 800, height: 600 };

function tree(...children: AxNode[]): AxNode {
  return { role: "AXWindow", frame: WINDOW, children };
}

const field = (frame: Rect | null, extra: Partial<AxNode> = {}): AxNode => ({
  role: "AXTextField",
  frame,
  ...extra,
});

describe("secure nodes", () => {
  test("are recognized by flag, role or subrole", () => {
    expect(isSecureNode({ role: "AXTextField", secure: true })).toBe(true);
    expect(isSecureNode({ role: "AXSecureTextField" })).toBe(true);
    expect(isSecureNode({ role: "AXTextField", subrole: "AXSecureTextField" })).toBe(true);
    expect(isSecureNode({ role: "Password" })).toBe(true);
    expect(isSecureNode({ role: "PasswordBox" })).toBe(true);
    expect(isSecureNode({ role: "edit", subrole: "securetextfield" })).toBe(true);
    expect(isSecureNode({ role: "AXTextField" })).toBe(false);
    expect(isSecureNode({ role: "AXTextField", subrole: null, secure: false })).toBe(false);
  });

  test("a focused secure field is secure focus, anywhere in the tree", () => {
    expect(
      secureFocus(
        tree(
          field(null, {
            role: "AXGroup",
            children: [field(null, { secure: true, focused: true })],
          }),
        ),
      ),
    ).toBe(true);
    expect(secureFocus(tree(field(null, { secure: true }), field(null, { focused: true })))).toBe(
      false,
    );
  });

  test("are rendered without a ref and without children for the model", () => {
    const secret = field(
      { x: 1, y: 1, width: 1, height: 1 },
      {
        role: "AXSecureTextField",
        ref: "e7",
        value: "hunter2",
        children: [{ role: "AXStaticText", label: "x" }],
      },
    );
    const plain: AxNode = { role: "AXButton", ref: "e1", label: "Save" };
    const masked = maskSecureNodes(tree(plain, { role: "AXGroup", children: [secret] }));
    expect(masked.children?.[0]).toBe(plain);
    expect(masked.children?.[1]?.children?.[0]).toEqual({
      role: "password",
      label: SECURE_PLACEHOLDER,
      ref: null,
      children: [],
    });
    expect(JSON.stringify(masked)).not.toContain("hunter2");
    expect(maskSecureNodes(plain)).toBe(plain);
  });
});

describe("redaction rectangles", () => {
  test("are window-relative, padded, rounded outward and sorted", () => {
    const result = redactRects(
      tree(
        field({ x: 300.4, y: 250.6, width: 99.2, height: 20 }, { sensitive: true }),
        field({ x: 200, y: 100, width: 100, height: 20 }, { secure: true }),
        field({ x: 500, y: 100, width: 50, height: 20 }),
      ),
      WINDOW,
    );
    expect(result).toEqual({
      ok: true,
      rects: [
        { x: 98, y: 48, width: 104, height: 24 },
        { x: 198, y: 198, width: 104, height: 25 },
      ],
    });
  });

  test("are clipped to the window and dropped when outside", () => {
    expect(
      redactRects(
        tree(
          field({ x: 90, y: 40, width: 20, height: 20 }, { secure: true }),
          field({ x: 880, y: 630, width: 50, height: 50 }, { secure: true }),
          field({ x: 2000, y: 2000, width: 10, height: 10 }, { secure: true }),
          field({ x: 0, y: 0, width: 10, height: 10 }, { secure: true }),
        ),
        WINDOW,
        0,
      ),
    ).toEqual({
      ok: true,
      rects: [
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 780, y: 580, width: 20, height: 20 },
      ],
    });
  });

  test("identical rectangles appear once and ties sort by size", () => {
    const frame = { x: 200, y: 100, width: 10, height: 10 };
    const result = redactRects(
      tree(
        field({ ...frame, height: 12 }, { secure: true }),
        field({ ...frame, width: 12 }, { secure: true }),
        field(frame, { secure: true }),
        field(frame, { sensitive: true }),
      ),
      WINDOW,
      0,
    );
    expect(result).toEqual({
      ok: true,
      rects: [
        { x: 100, y: 50, width: 10, height: 10 },
        { x: 100, y: 50, width: 10, height: 12 },
        { x: 100, y: 50, width: 12, height: 10 },
      ],
    });
  });

  test("a window without secure fields needs no rectangles", () => {
    expect(redactRects(tree(field({ x: 1, y: 1, width: 1, height: 1 })), WINDOW)).toEqual({
      ok: true,
      rects: [],
    });
    expect(REDACTION_PADDING).toBe(2);
    expect(SECURE_PLACEHOLDER).toBe("[password, hidden]");
  });

  test("refuse the screenshot when a field to hide has no usable bounds", () => {
    for (const frame of [
      null,
      undefined,
      { x: 1, y: 1, width: 0, height: 5 },
      { x: 1, y: 1, width: 5, height: 0 },
      { x: Number.NaN, y: 1, width: 5, height: 5 },
    ]) {
      expect(redactRects(tree(field(frame ?? null, { secure: true })), WINDOW)).toEqual({
        ok: false,
        code: "secure_focus",
      });
    }
    expect(redactRects(tree({ role: "AXSecureTextField" }), WINDOW).ok).toBe(false);
  });

  test("refuse the screenshot while a secure field has focus or the window has no bounds", () => {
    const focused = tree(
      field({ x: 200, y: 100, width: 10, height: 10 }, { secure: true, focused: true }),
    );
    expect(redactRects(focused, WINDOW)).toEqual({ ok: false, code: "secure_focus" });
    expect(redactRects(tree(), { x: 0, y: 0, width: 0, height: 10 })).toEqual({
      ok: false,
      code: "secure_focus",
    });
    expect(screenshotPolicy(focused, WINDOW)).toEqual({ ok: false, code: "secure_focus" });
    expect(screenshotPolicy(tree(), WINDOW)).toEqual({ ok: true });
  });
});

describe("redaction edges", () => {
  const at = (x: number, y: number, width = 10, height = 10): AxNode =>
    field({ x: WINDOW.x + x, y: WINDOW.y + y, width, height }, { secure: true });

  test("a field that starts exactly at the right or bottom edge is dropped", () => {
    expect(redactRects(tree(at(800, 100)), WINDOW, 0)).toEqual({ ok: true, rects: [] });
    expect(redactRects(tree(at(100, 600)), WINDOW, 0)).toEqual({ ok: true, rects: [] });
    expect(redactRects(tree(at(900, 100)), WINDOW, 0)).toEqual({ ok: true, rects: [] });
    expect(redactRects(tree(at(100, 900)), WINDOW, 0)).toEqual({ ok: true, rects: [] });
  });

  test("a field one pixel inside the edge is kept", () => {
    expect(redactRects(tree(at(799, 599)), WINDOW, 0)).toEqual({
      ok: true,
      rects: [{ x: 799, y: 599, width: 1, height: 1 }],
    });
  });

  test("sorts by top edge first, then by left edge", () => {
    expect(redactRects(tree(at(0, 50), at(50, 0)), WINDOW, 0)).toEqual({
      ok: true,
      rects: [
        { x: 50, y: 0, width: 10, height: 10 },
        { x: 0, y: 50, width: 10, height: 10 },
      ],
    });
    expect(redactRects(tree(at(50, 0), at(0, 0)), WINDOW, 0)).toEqual({
      ok: true,
      rects: [
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 50, y: 0, width: 10, height: 10 },
      ],
    });
  });

  test("a node with a null subrole is checked by its role", () => {
    expect(isSecureNode({ role: "AXSecureTextField", subrole: null })).toBe(true);
    expect(isSecureNode({ role: "AXTextField", subrole: null })).toBe(false);
  });
});

describe("screenshot size", () => {
  test("downscales the longest edge to 1280 and keeps small images", () => {
    expect(SCREENSHOT_MAX_EDGE).toBe(1280);
    expect(screenshotSize(800, 600)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(screenshotSize(1280, 1)).toEqual({ width: 1280, height: 1, scale: 1 });
    expect(screenshotSize(2560, 1600)).toEqual({ width: 1280, height: 800, scale: 0.5 });
    expect(screenshotSize(1000, 3000)).toEqual({ width: 427, height: 1280, scale: 1280 / 3000 });
    expect(screenshotSize(5000, 1)).toEqual({ width: 1280, height: 1, scale: 1280 / 5000 });
    expect(screenshotSize(200, 100, 100)).toEqual({ width: 100, height: 50, scale: 0.5 });
  });

  test("scaled rectangles still cover the original area", () => {
    expect(scaleRects([{ x: 3, y: 5, width: 3, height: 3 }], 0.5)).toEqual([
      { x: 1, y: 2, width: 2, height: 2 },
    ]);
    expect(scaleRects([{ x: 10, y: 10, width: 10, height: 10 }], 1)).toEqual([
      { x: 10, y: 10, width: 10, height: 10 },
    ]);
  });
});
