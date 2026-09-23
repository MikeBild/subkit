// A value class the engine accepts and this dialog cannot describe makes the
// workflow unapprovable.
//
// `file_name` was added to the engine so a content repository could be
// addressed by file name instead of an enum of every file that would ever
// exist. The approval panel was not told. It did the safe thing — "limited by a
// rule this dialog cannot describe, do not approve" — and a repaired production
// workflow could not be put into service at all. Nothing was wrong with the
// workflow; the sentence was missing.
//
// The engine's table is read from its source text rather than imported: this
// project's compiler does not resolve the engine's module aliases, and a check
// that cannot run is worth nothing. The parse asserts it found classes at all,
// so a rename that breaks the pattern fails here instead of passing on an
// empty set.

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
  // The other direction: a sentence for a class that no longer exists promises
  // an approver something the engine cannot enforce.
  const classes = engineValueClasses();
  expect(Object.keys(CLASS_KEYS).filter((name) => !classes.includes(name))).toEqual([]);
});
