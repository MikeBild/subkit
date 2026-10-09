import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buttonVariants } from "./button";

const SIZES = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;
const CONTROLS = ["input.tsx", "select.tsx", "textarea.tsx", "input-group.tsx"];

describe("every control shares one corner", () => {
  test("no button size is rounder than the others", () => {
    for (const size of SIZES) {
      const classes = buttonVariants({ size });
      expect(classes).not.toMatch(/(^|\s)rounded-(lg|xl)(\s|$)/);
    }
    expect(buttonVariants()).toContain("rounded-md");
  });

  test("text fields and pickers use the same corner as buttons", () => {
    for (const file of CONTROLS) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source).not.toMatch(
        /h-8 w-full min-w-0 (items-center )?rounded-lg|gap-1\.5 rounded-lg border|w-full rounded-lg border/,
      );
    }
  });

  test("a regular button keeps the same inner spacing as the design", () => {
    expect(buttonVariants()).toContain("px-3");
    expect(buttonVariants({ size: "sm" })).toContain("text-[13px]");
  });

  test("every list heads its columns the same quiet way", () => {
    const table = readFileSync(join(import.meta.dir, "table.tsx"), "utf8");
    expect(table).toContain("[&_tr]:h-9");
    expect(table).toContain(
      "h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground",
    );
    expect(table).toContain("min-w-0 px-3 py-1 align-middle");
  });
});
