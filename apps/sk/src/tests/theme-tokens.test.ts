import {
  defaultTheme,
  paletteFor,
  PALETTES,
  shouldForceNoColor,
  type ThemeName,
  type ThemeTokens,
} from "@chat-ui/index.ts";
import { describe, expect, test } from "bun:test";

const ALL_THEMES: ThemeName[] = ["dark", "light", "highContrast", "noColor"];

describe("theme tokens", () => {
  test("defaultTheme is the dark palette", () => {
    expect(defaultTheme).toEqual(PALETTES.dark);
  });

  test("paletteFor resolves named palettes; unknown falls back to dark", () => {
    expect(paletteFor("dark")).toBe(PALETTES.dark);
    expect(paletteFor("light")).toBe(PALETTES.light);
    expect(paletteFor("highContrast")).toBe(PALETTES.highContrast);
    expect(paletteFor("noColor")).toBe(PALETTES.noColor);
    expect(paletteFor(undefined)).toBe(defaultTheme);
    expect(paletteFor("phantom" as ThemeName)).toBe(defaultTheme);
  });

  test("every palette covers the same token surface (no missing keys)", () => {
    const referenceShape = collectKeys(PALETTES.dark);
    for (const name of ALL_THEMES) {
      expect(collectKeys(PALETTES[name])).toEqual(referenceShape);
    }
  });

  test("noColor palette returns empty strings everywhere", () => {
    const tokens = PALETTES.noColor;
    const flatten = (obj: Record<string, unknown>): string[] => {
      const out: string[] = [];
      for (const v of Object.values(obj)) {
        if (typeof v === "string") out.push(v);
        else if (v && typeof v === "object") out.push(...flatten(v as Record<string, unknown>));
      }
      return out;
    };
    const values = flatten(tokens as unknown as Record<string, unknown>);
    expect(values.every((v) => v === "")).toBe(true);
    expect(values.length).toBeGreaterThan(40);
  });

  test("dark palette covers every documented role / severity / mode", () => {
    const t = PALETTES.dark;
    expect(t.role.user).toBeTruthy();
    expect(t.role.assistant).toBeTruthy();
    expect(t.role.tool).toBeTruthy();
    expect(t.role.system).toBeTruthy();
    expect(t.severity.error).toBeTruthy();
    expect(t.severity.warning).toBeTruthy();
    expect(t.severity.info).toBeTruthy();
    expect(t.severity.success).toBeTruthy();
    expect(t.severity.dim).toBeTruthy();
    expect(t.mode.plan).toBeTruthy();
    expect(t.mode.yolo).toBe("red");
    expect(t.gutter.assistant).toBe(t.role.assistant);
  });

  test("shouldForceNoColor honors NO_COLOR (presence-driven)", () => {
    expect(shouldForceNoColor({ NO_COLOR: "1" })).toBe(true);
    expect(shouldForceNoColor({ NO_COLOR: "" })).toBe(false);
    expect(shouldForceNoColor({})).toBe(false);
  });

  test("shouldForceNoColor honors SK_PLAIN", () => {
    expect(shouldForceNoColor({ SK_PLAIN: "1" })).toBe(true);
    expect(shouldForceNoColor({ SK_PLAIN: "true" })).toBe(true);
    expect(shouldForceNoColor({ SK_PLAIN: "0" })).toBe(false);
    expect(shouldForceNoColor({ SK_PLAIN: "" })).toBe(false);
  });

  test("token registry exhaustiveness — surfaces all 13 token groups", () => {
    const groups = Object.keys(PALETTES.dark) as (keyof ThemeTokens)[];
    expect(groups).toContain("role");
    expect(groups).toContain("severity");
    expect(groups).toContain("mode");
    expect(groups).toContain("emphasis");
    expect(groups).toContain("surface");
    expect(groups).toContain("border");
    expect(groups).toContain("accent");
    expect(groups).toContain("chrome");
    expect(groups).toContain("gutter");
    expect(groups).toContain("cursor");
    expect(groups).toContain("diff");
    expect(groups).toContain("spinner");
    expect(groups).toContain("badge");
    expect(groups.length).toBe(13);
  });
});

function collectKeys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(path);
    else if (v && typeof v === "object") out.push(...collectKeys(v, path));
  }
  return out.sort();
}
