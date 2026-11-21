import { describe, expect, test } from "bun:test";
import { parseStartLayout, START_LAYOUT_DEFAULT, startPanelOpen } from "./start-layout";

describe("how the sidebars start", () => {
  test("nothing chosen keeps the left bar open and the right panel as last left", () => {
    expect(parseStartLayout(null)).toEqual(START_LAYOUT_DEFAULT);
    expect(parseStartLayout("not json")).toEqual(START_LAYOUT_DEFAULT);
    expect(startPanelOpen(true, START_LAYOUT_DEFAULT)).toBe(true);
    expect(startPanelOpen(false, START_LAYOUT_DEFAULT)).toBe(false);
  });

  test("a chosen start wins over the remembered panel", () => {
    const layout = parseStartLayout('{"leftCollapsed":true,"rightOpen":false}');
    expect(layout).toEqual({ leftCollapsed: true, rightOpen: false });
    expect(startPanelOpen(true, layout)).toBe(false);
    expect(startPanelOpen(false, { ...layout, rightOpen: true })).toBe(true);
    expect(parseStartLayout('{"leftCollapsed":"yes","rightOpen":1}')).toEqual(START_LAYOUT_DEFAULT);
  });
});
