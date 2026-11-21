import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buttonVariants } from "@ui/components/ui/button";
import { toggleVariants } from "@ui/components/ui/toggle";

const UI = join(import.meta.dir, "../components/ui");
const source = (file: string) => readFileSync(join(UI, file), "utf8");

const SIZES = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;
const CONTROLS = [
  "button.tsx",
  "button-group.tsx",
  "input.tsx",
  "textarea.tsx",
  "select.tsx",
  "checkbox.tsx",
  "switch.tsx",
  "toggle.tsx",
  "tabs.tsx",
  "input-group.tsx",
];

describe("one control set with 40 px controls", () => {
  test("every button, field, picker, toggle and tab is 40 px high, the small sizes too", () => {
    expect(buttonVariants()).toContain("h-10");
    expect(buttonVariants({ size: "sm" })).toContain("h-10");
    expect(buttonVariants({ size: "sm" })).toContain("text-xs");
    expect(buttonVariants({ size: "icon" })).toContain("size-10");
    expect(buttonVariants({ size: "icon-sm" })).toContain("size-10");
    expect(toggleVariants()).toContain("h-10");
    expect(toggleVariants({ size: "sm" })).toContain("h-10");
    expect(source("input.tsx")).toContain("h-10");
    expect(source("select.tsx")).toContain("data-[size=default]:h-10");
    expect(source("select.tsx")).toContain("data-[size=sm]:h-10");
    expect(source("input-group.tsx")).toContain("h-10");
    expect(source("tabs.tsx")).toContain("h-10");
  });

  test("every button size shares the control corner", () => {
    for (const size of SIZES) {
      const classes = buttonVariants({ size });
      expect(classes).toContain("rounded-control");
      expect(classes).not.toMatch(/(^|\s)rounded-(md|lg|xl)(\s|$)/);
    }
  });

  test("no control switches off the shared focus outline", () => {
    for (const file of CONTROLS.filter((name) => name !== "input-group.tsx")) {
      expect(source(file)).not.toMatch(/(?:focus-visible|focus):outline-none/);
      expect(source(file)).not.toMatch(/focus-visible:ring-1|focus:ring-1/);
    }
    expect(source("input-group.tsx")).toContain(
      "has-[[data-slot=input-group-control]:focus-visible]:outline-2",
    );
    expect(readFileSync(join(import.meta.dir, "../styles/tokens.css"), "utf8")).toMatch(
      /:focus-visible\s*\{\s*outline:\s*2px solid var\(--ring\);\s*outline-offset:\s*2px;/,
    );
  });

  test("selection surfaces highlight neutrally, never in the accent", () => {
    for (const file of ["dropdown-menu.tsx", "select.tsx", "toggle.tsx", "dialog.tsx"]) {
      expect(source(file)).not.toMatch(/(?:hover|focus|data-\[state=(?:open|on)\]):bg-accent/);
    }
  });

  test("table rows leave room for a 40 px control", () => {
    const table = source("table.tsx");
    expect(table).toContain('"h-12 border-b');
    expect(table).toContain("table-fixed");
  });
});

const TOKENS = readFileSync(join(import.meta.dir, "../styles/tokens.css"), "utf8");
const TRACK = { light: "#f1f5f9", dark: "#1e293b" } as const;

function token(theme: "light" | "dark", name: string): string {
  const block = theme === "light" ? TOKENS.split(".dark {")[0] : TOKENS.split(".dark {")[1];
  const found = block?.match(new RegExp(`--${name}: (#[0-9a-f]{6});`));
  if (!found?.[1]) throw new Error(`${name} missing in ${theme}`);
  return found[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("one selected state for every segment toggle", () => {
  test("toggle items and tabs use the selected token, nothing else", () => {
    expect(toggleVariants()).toContain("data-[state=on]:bg-segment-selected");
    expect(toggleVariants()).toContain("data-[state=on]:inset-ring-segment-selected-ring");
    expect(source("tabs.tsx")).toContain("data-[state=active]:bg-segment-selected");
    expect(source("tabs.tsx")).toContain("data-[state=active]:inset-ring-segment-selected-ring");
  });

  for (const theme of ["light", "dark"] as const)
    test(`${theme}: the label reads at AA and the selected outline stands out at 3:1`, () => {
      const selected = token(theme, "segment-selected");
      expect(
        contrast(token(theme, "segment-selected-foreground"), selected),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(theme, "segment-selected-ring"), TRACK[theme])).toBeGreaterThanOrEqual(
        3,
      );
      expect(contrast(token(theme, "segment-selected-ring"), selected)).toBeGreaterThanOrEqual(3);
    });
});
