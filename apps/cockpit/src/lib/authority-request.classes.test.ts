import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLASS_KEYS } from "./authority-request";
import { CATALOGS } from "./i18n";

const ENGINE_SOURCE = new URL("../../../engine/src/workflows/request-boundary.ts", import.meta.url)
  .pathname;

function engineValueClasses(): string[] {
  const source = readFileSync(ENGINE_SOURCE, "utf8");
  const table = /export const VALUE_CLASSES = \{([\s\S]*?)\n\} as const;/.exec(source);
  if (!table?.[1]) throw new Error(`VALUE_CLASSES not found in ${ENGINE_SOURCE}`);
  return [...table[1].matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*\//gm)].map((match) =>
    String(match[1]),
  );
}

test("the engine's class table is readable, or this whole check proves nothing", () => {
  const classes = engineValueClasses();
  expect(classes.length).toBeGreaterThan(3);
  expect(classes).toContain("uuid");
});

test("every value class the engine accepts has a sentence in every language", () => {
  const missing = engineValueClasses().filter((name) => !CLASS_KEYS[name]);
  expect(missing).toEqual([]);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    const untranslated = Object.values(CLASS_KEYS).filter(
      (key) => typeof (catalog as Record<string, string>)[key] !== "string",
    );
    expect({ locale, untranslated }).toEqual({ locale, untranslated: [] });
  }
});

test("the dialog describes no class the engine would refuse", () => {
  const classes = engineValueClasses();
  expect(Object.keys(CLASS_KEYS).filter((name) => !classes.includes(name))).toEqual([]);
});
