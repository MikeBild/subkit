import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATALOGS, translate } from "@/lib/i18n";
import { shownInCockpit } from "./settings-areas";
import { settingHelpKey, settingLabel, settingSectionOf } from "./settings-model";

const WALK = resolve(import.meta.dir, "../../../../../engine/src/config/walk.ts");
const { listConfigLeaves } = (await import(WALK)) as {
  listConfigLeaves(): Array<{
    path: string[];
    kind: string;
    meta: { requiresRestart?: boolean };
  }>;
};
const LEAVES = listConfigLeaves();
const ALL_PATHS = LEAVES.map((leaf) => leaf.path.join("."));
const PATHS = ALL_PATHS.filter(shownInCockpit);
const SK = readFileSync(
  resolve(import.meta.dir, "../../../../../sk/src/commands/settings.ts"),
  "utf8",
);

describe("the engine's settings", () => {
  test("are read (a moved file must not pass vacuously)", () => {
    expect(ALL_PATHS.length).toBeGreaterThan(150);
    expect(PATHS.length).toBeGreaterThan(100);
  });

  test("no setting is lost: what the Cockpit leaves out, sk reads and writes by its path", () => {
    expect(ALL_PATHS.length - PATHS.length).toBeGreaterThan(60);
    expect(SK).toContain("client.getSetting(args.path as string");
    expect(SK).toContain("client.setSetting(args.path as string");
  });

  test("the Cockpit shows no server operation setting", () => {
    for (const path of ["database.url", "log.level", "queue.concurrency", "sandbox.wall_ms"])
      expect(shownInCockpit(path)).toBe(false);
    for (const path of ["llm.provider", "tokens.currency", "deployment.mode"])
      expect(shownInCockpit(path)).toBe(true);
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

const MUST_EXPLAIN = LEAVES.filter((leaf) => shownInCockpit(leaf.path.join(".")))
  .filter(
    (leaf) =>
      /^(llm|tokens|auth|notifications|chat)$/.test(leaf.path[0] ?? "") ||
      leaf.meta.requiresRestart === true ||
      leaf.kind === "enum",
  )
  .map((leaf) => leaf.path.join("."));

const HELPED = PATHS.filter((path) => settingHelpKey(path) !== null);

describe("help on a setting", () => {
  test("covers the settings people change, every restart and every choice", () => {
    expect(MUST_EXPLAIN.length).toBeGreaterThan(60);
    expect(MUST_EXPLAIN.filter((path) => settingHelpKey(path) === null)).toEqual([]);
  });

  test("names only settings the engine has", () => {
    const stale = Object.keys(CATALOGS.en)
      .filter((key) => key.startsWith("settings.help."))
      .map((key) => key.slice("settings.help.".length))
      .filter((path) => !PATHS.includes(path));
    expect(stale).toEqual([]);
  });

  test("reads in both languages, and differently", () => {
    for (const path of HELPED) {
      const key = settingHelpKey(path)!;
      const en = translate("en", key);
      const de = translate("de", key);
      expect(en.length, path).toBeGreaterThan(10);
      expect(de.length, path).toBeGreaterThan(10);
      expect(de, path).not.toBe(en);
    }
  });

  test("a setting without help shows none", () => {
    expect(settingHelpKey("sandbox.tick_budget")).toBeNull();
    expect(HELPED.length).toBeGreaterThanOrEqual(MUST_EXPLAIN.length);
  });
});
