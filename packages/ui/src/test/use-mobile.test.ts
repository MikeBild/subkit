import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NAVIGATION_SHEET_BELOW_REM,
  NAVIGATION_SHEET_QUERY,
  navigationIsSheet,
} from "@ui/hooks/use-mobile";

const src = join(import.meta.dir, "..");

describe("navigation mode", () => {
  test("phones and tablets in portrait open the navigation as a sheet", () => {
    for (const width of [320, 375, 393, 430, 744, 767, 768, 820, 1023, 1024, 1099]) {
      expect(navigationIsSheet(width)).toBe(true);
    }
  });

  test("tablets in landscape and laptops dock the navigation", () => {
    for (const width of [1100, 1133, 1180, 1280, 1366, 1440]) {
      expect(navigationIsSheet(width)).toBe(false);
    }
  });

  test("a fractional width at the boundary still picks exactly one mode", () => {
    expect(navigationIsSheet(1099.5)).toBe(true);
    expect(navigationIsSheet(1100)).toBe(false);
  });

  test("the script and the stylesheet switch at the same width", () => {
    const css = readFileSync(join(src, "styles/tokens.css"), "utf8");
    expect(NAVIGATION_SHEET_QUERY).toBe(`(width < ${NAVIGATION_SHEET_BELOW_REM}rem)`);
    expect(css).toContain(
      `@custom-variant nav-docked (@media (width >= ${NAVIGATION_SHEET_BELOW_REM}rem));`,
    );
  });

  test("the sidebar docks only at the navigation breakpoint", () => {
    const sidebar = readFileSync(join(src, "organisms/sidebar.tsx"), "utf8");
    expect(sidebar).not.toMatch(/(^|[\s"'])md:/m);
    expect(sidebar).toContain("nav-docked:block");
    expect(sidebar).toContain("nav-docked:flex");
  });
});
