// The settings page's model: which section a setting lives in, how the
// sections are grouped, what the address carries and when the page asks
// something of the reader.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { settingsHref } from "@/app/links";
import { CATALOGS, translate } from "@/lib/i18n";
import {
  SETTING_GROUPS,
  SETTING_SECTION_KEYS,
  settingLabel,
  settingLeafTarget,
  settingMetaLabel,
  settingNavigation,
  settingSectionOf,
  settingSourceIsNotable,
  settingsAttention,
  settingsLeafFromUrl,
  settingsViewFromUrl,
} from "@/pages/settings-model";

const query = (href: string) => href.slice(href.indexOf("?"));

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);

// A computed specifier: the cockpit's type-check does not follow it into the
// engine's sources, and bun runs it as the engine does.
const WALK = resolve(import.meta.dir, "../../../engine/src/config/walk.ts");
const { listConfigLeaves } = (await import(WALK)) as {
  listConfigLeaves(): Array<{ path: string[] }>;
};
const ENGINE_SECTIONS = [...new Set(listConfigLeaves().map((leaf) => leaf.path[0] ?? ""))];

describe("the section list", () => {
  test("reads the engine's sections (a moved file must not pass vacuously)", () => {
    expect(ENGINE_SECTIONS.length).toBeGreaterThan(15);
  });

  test("places every section the engine has in a group, exactly once", () => {
    const placed = SETTING_GROUPS.flatMap((group) => group.sections);
    expect(ENGINE_SECTIONS.filter((section) => !placed.includes(section))).toEqual([]);
    expect(new Set(placed).size).toBe(placed.length);
    // Nothing placed that the engine does not have.
    expect(placed.filter((section) => !ENGINE_SECTIONS.includes(section))).toEqual([]);
  });

  test("names every section and every group in both languages", () => {
    for (const section of ENGINE_SECTIONS) {
      const key = SETTING_SECTION_KEYS[section];
      expect(key, section).toBeDefined();
      expect(Object.hasOwn(CATALOGS.de, key as string)).toBe(true);
      expect(Object.hasOwn(CATALOGS.en, key as string)).toBe(true);
    }
    for (const group of SETTING_GROUPS) {
      expect(Object.hasOwn(CATALOGS.de, group.label)).toBe(true);
      expect(Object.hasOwn(CATALOGS.en, group.label)).toBe(true);
    }
  });

  test("the engine's maintenance section has a name of its own, not 'more settings'", () => {
    expect(de(SETTING_SECTION_KEYS.operations!)).toBe("Wartung");
  });

  test("an installation's sections come back grouped, in the declared order", () => {
    const nav = settingNavigation(ENGINE_SECTIONS);
    expect(nav.map((group) => group.id)).toEqual([
      "ai",
      "access",
      "integrations",
      "execution",
      "sk",
      "operations",
    ]);
    expect(nav.flatMap((group) => group.sections).sort()).toEqual([...ENGINE_SECTIONS].sort());
  });

  test("a group without settings is left out; a section a newer engine adds is not lost", () => {
    const nav = settingNavigation(["tokens", "frobnicate"]);
    expect(nav).toEqual([
      { id: "ai", label: "settings.group.ai", sections: ["tokens"] },
      { id: "other", label: "settings.group.other", sections: ["frobnicate"] },
    ]);
  });
});

describe("what the page asks before any section", () => {
  test("nothing when every saved change is active", () => {
    expect(
      settingsAttention({ pending_restart_fields: [], activation_status: "active" }),
    ).toBeNull();
    expect(settingsAttention(undefined)).toBeNull();
  });

  test("the settings waiting for a restart, by path", () => {
    expect(
      settingsAttention({
        pending_restart_fields: ["auth.providers"],
        activation_status: "restart_required",
      }),
    ).toEqual({ restart: ["auth.providers"], notActivated: false });
  });

  test("a last change that failed to activate", () => {
    expect(settingsAttention({ pending_restart_fields: [], activation_status: "failed" })).toEqual({
      restart: [],
      notActivated: true,
    });
  });
});

describe("setting sources", () => {
  test("a known source is named regardless of case", () => {
    expect(settingMetaLabel("ENV", de)).toEqual({
      text: de("settings.meta.environment"),
      machine: false,
    });
  });

  test("an unnamed source is the machine value", () => {
    expect(settingMetaLabel("vault", de)).toEqual({ text: "vault", machine: true });
  });

  test("the row names its source only when it is not the plain installation value or default", () => {
    expect(settingSourceIsNotable("global")).toBe(false);
    expect(settingSourceIsNotable("default")).toBe(false);
    expect(settingSourceIsNotable("tenant")).toBe(true);
    expect(settingSourceIsNotable("env")).toBe(true);
    expect(settingSourceIsNotable("override")).toBe(true);
  });
});

describe("the settings leaf a link opens", () => {
  test("reads a dotted setting path", () => {
    expect(settingsLeafFromUrl("?leaf=server.public_base_url")).toBe("server.public_base_url");
    expect(settingsLeafFromUrl("?leaf=llm")).toBe("llm");
  });

  test("drops what could not name a setting", () => {
    for (const bad of ["", "?leaf=", "?leaf=a..b", "?leaf=.a", "?leaf=a%20b", "?leaf=a/b"])
      expect(settingsLeafFromUrl(bad)).toBeNull();
    expect(settingsLeafFromUrl(`?leaf=${"a".repeat(129)}`)).toBeNull();
  });
});

describe("the settings view a link opens", () => {
  test("a leaf opens the section it lives in", () => {
    expect(settingSectionOf("tokens.monthly_budget")).toBe("tokens");
    expect(settingSectionOf("llm")).toBe("llm");
  });

  test("the address carries leaf, section and search, and drops junk", () => {
    expect(settingsViewFromUrl(query(settingsHref("tokens.monthly_budget")))).toEqual({
      leaf: "tokens.monthly_budget",
      section: null,
      q: "",
    });
    expect(settingsViewFromUrl(query(settingsHref(null, { section: "llm", q: "model" })))).toEqual({
      leaf: null,
      section: "llm",
      q: "model",
    });
    expect(settingsViewFromUrl("?section=a%2Fb").section).toBeNull();
  });

  test("a setting is named in the reader's language, with its parent where needed", () => {
    expect(settingLabel("tokens.monthly_budget", de)).toEqual({
      text: "Monatliches Token-Kontingent",
      machine: false,
    });
    expect(settingLabel("llm.providers.anthropic.api_key", de).text).toBe(
      "Anthropic · API-Schlüssel",
    );
  });
});

describe("where a ?leaf= address lands", () => {
  const paths = [
    "llm.provider",
    "llm.providers.anthropic.api_key",
    "llm.providers.anthropic.model",
  ];

  test("a setting is itself; a group opens at its first setting", () => {
    expect(settingLeafTarget(paths, "llm.provider")).toEqual({ index: 0, kind: "leaf" });
    expect(settingLeafTarget(paths, "llm.providers.anthropic")).toEqual({
      index: 1,
      kind: "group",
    });
    expect(settingLeafTarget(paths, "llm")).toEqual({ index: 0, kind: "group" });
  });

  test("only a path nothing lives under is missing", () => {
    expect(settingLeafTarget(paths, "llm.providers.frob")).toBeNull();
    // A prefix of a word is not a group.
    expect(settingLeafTarget(paths, "llm.prov")).toBeNull();
  });
});
