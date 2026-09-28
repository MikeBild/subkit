// Every setting the engine has is named, in both languages, and no two
// settings on one tab read the same.
//
// Walks the engine's own config (`listConfigLeaves`), the way the permission
// test reads permissions.json: a setting added there without a name here fails
// CI instead of reaching the German page as "Api key" or a raw path.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { translate } from "@/lib/i18n";
import { settingLabel, settingSectionOf } from "@/pages/settings-model";

// A computed specifier: the cockpit's type-check does not follow it into the
// engine's sources, and bun runs it as the engine does.
const WALK = resolve(import.meta.dir, "../../../engine/src/config/walk.ts");
const { listConfigLeaves } = (await import(WALK)) as {
  listConfigLeaves(): Array<{ path: string[] }>;
};
const PATHS = listConfigLeaves().map((leaf) => leaf.path.join("."));

describe("the engine's settings", () => {
  test("are read (a moved file must not pass vacuously)", () => {
    expect(PATHS.length).toBeGreaterThan(100);
  });

  for (const locale of ["de", "en"] as const) {
    const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
      translate(locale, key, values);

    test(`every setting has a ${locale} name`, () => {
      expect(PATHS.filter((path) => settingLabel(path, t).machine)).toEqual([]);
    });

    test(`no two settings in one section share a ${locale} name`, () => {
      const seen = new Map<string, string>();
      for (const path of PATHS) {
        const id = `${settingSectionOf(path)} / ${settingLabel(path, t).text}`;
        expect(seen.get(id), `${path} reads like ${seen.get(id)}`).toBeUndefined();
        seen.set(id, path);
      }
    });
  }

  test("a path this build does not know is the path, marked as a machine value", () => {
    const de = (key: Parameters<typeof translate>[1]) => translate("de", key);
    expect(settingLabel("llm.providers.frob.api_key", de)).toEqual({
      text: "llm.providers.frob.api_key",
      machine: true,
    });
  });
});
