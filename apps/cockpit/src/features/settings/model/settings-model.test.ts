import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { settingsHref } from "@/app/links";
import { CATALOGS, translate } from "@/lib/i18n";
import { SETTING_AREAS, settingNavigation } from "./settings-areas";
import {
  changedSettings,
  isUnset,
  nextSettingsSave,
  parseSettingDraft,
  pendingSettingDrafts,
  SETTING_SECTION_KEYS,
  type SettingItem,
  settingDiffersFromDefault,
  settingDraftError,
  settingDraftTexts,
  settingFieldValue,
  settingIsChanged,
  settingLabel,
  settingLeafTarget,
  settingMetaLabel,
  settingResetDraft,
  settingSecretCover,
  settingSecretName,
  settingSectionOf,
  settingSourceIsNotable,
  settingsActivationPath,
  settingsAttention,
  settingsLeafFromUrl,
  settingsPatches,
  settingsSaveFailure,
  settingsSaveReason,
  settingsViewFromUrl,
  settingUnit,
  settingValueText,
  withoutSettingDraft,
  withSettingDraft,
} from "./settings-model";

const query = (href: string) => href.slice(href.indexOf("?"));

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);

const WALK = resolve(import.meta.dir, "../../../../../engine/src/config/walk.ts");
const { listConfigLeaves } = (await import(WALK)) as {
  listConfigLeaves(): Array<{ path: string[] }>;
};
const ENGINE_SECTIONS = [...new Set(listConfigLeaves().map((leaf) => leaf.path[0] ?? ""))];

const SERVER_SECTIONS =
  "server database log errors operations observability queue sandbox repl ui".split(" ");

const COCKPIT_SECTIONS = ENGINE_SECTIONS.filter((section) => !SERVER_SECTIONS.includes(section));

describe("the section list", () => {
  test("reads the engine's sections (a moved file must not pass vacuously)", () => {
    expect(ENGINE_SECTIONS.length).toBeGreaterThan(15);
  });

  test("every engine section is either in the Cockpit or a server section for sk", () => {
    const placed = SETTING_AREAS.flatMap((group) => group.sections);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual([...COCKPIT_SECTIONS].sort());
    expect(SERVER_SECTIONS.filter((section) => !ENGINE_SECTIONS.includes(section))).toEqual([]);
  });

  test("names every Cockpit section and every group in both languages", () => {
    for (const section of COCKPIT_SECTIONS) {
      const key = SETTING_SECTION_KEYS[section];
      expect(key, section).toBeDefined();
      expect(Object.hasOwn(CATALOGS.de, key as string)).toBe(true);
      expect(Object.hasOwn(CATALOGS.en, key as string)).toBe(true);
    }
    for (const group of settingNavigation(COCKPIT_SECTIONS)) {
      expect(Object.hasOwn(CATALOGS.de, group.label)).toBe(true);
      expect(Object.hasOwn(CATALOGS.en, group.label)).toBe(true);
    }
  });

  test("an installation's sections come back grouped, in the declared order", () => {
    const nav = settingNavigation(COCKPIT_SECTIONS);
    expect(nav.map((group) => group.id)).toEqual([
      "ai",
      "access",
      "connections",
      "notifications",
      "operations",
    ]);
    expect(nav.flatMap((group) => group.sections).sort()).toEqual([...COCKPIT_SECTIONS].sort());
  });

  test("a group without settings is left out", () => {
    expect(settingNavigation(["tokens"])).toEqual([
      { id: "ai", label: "settings.area.ai.title", sections: ["tokens"] },
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
    expect(settingSectionOf("connectors.mcp.tools_list_max_pages")).toBe("connectors");
    expect(settingSectionOf("llm")).toBe("llm");
  });

  test("the address carries leaf, section and filter, and drops junk", () => {
    expect(settingsViewFromUrl(query(settingsHref("connectors.mcp.tools_list_max_pages")))).toEqual(
      {
        leaf: "connectors.mcp.tools_list_max_pages",
        section: null,
        filter: "all",
      },
    );
    expect(
      settingsViewFromUrl(query(settingsHref(null, { section: "llm", filter: "changed" }))),
    ).toEqual({
      leaf: null,
      section: "llm",
      filter: "changed",
    });
    expect(settingsViewFromUrl("?section=a%2Fb").section).toBeNull();
  });

  test("a setting is named in the reader's language, with its parent where needed", () => {
    expect(settingLabel("connectors.mcp.tools_list_max_pages", de)).toEqual({
      text: "Externes MCP · Seiten der Werkzeugliste",
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
    expect(settingLeafTarget(paths, "llm.prov")).toBeNull();
  });
});

describe("a setting's text field", () => {
  const meta = { sensitive: false } as SettingItem["meta"];
  test("an unset setting shows an empty field, never the word null", () => {
    expect(settingFieldValue({ value: null, meta }, undefined)).toBe("");
    expect(isUnset({ value: null })).toBe(true);
  });
  test("a set value, a draft and a secret", () => {
    expect(settingFieldValue({ value: "info", meta }, undefined)).toBe("info");
    expect(settingFieldValue({ value: 3, meta }, undefined)).toBe("3");
    expect(settingFieldValue({ value: "info", meta }, "debug")).toBe("debug");
    expect(
      settingFieldValue(
        { value: "x", meta: { sensitive: true } as SettingItem["meta"] },
        undefined,
      ),
    ).toBe("");
  });
});

function setting(
  path: string,
  value: unknown,
  meta: Partial<SettingItem["meta"]> & { kind: string },
): SettingItem {
  return {
    path,
    value,
    meta: {
      source: "default",
      scope: "global",
      sensitive: false,
      requiresRestart: false,
      ...meta,
    },
  };
}

describe("the Geändert filter", () => {
  test("a ?filter=changed link opens the filter; anything else is all", () => {
    expect(settingsViewFromUrl(query(settingsHref(null, { filter: "changed" }))).filter).toBe(
      "changed",
    );
    expect(settingsViewFromUrl("?filter=bogus").filter).toBe("all");
    expect(settingsViewFromUrl("").filter).toBe("all");
  });

  test("a setting is changed when its stored value is not the schema's default", () => {
    expect(settingIsChanged(setting("log.level", "debug", { kind: "enum", default: "info" }))).toBe(
      true,
    );
    expect(settingIsChanged(setting("log.level", "info", { kind: "enum", default: "info" }))).toBe(
      false,
    );
    expect(
      settingIsChanged(
        setting("tokens.prices", [{ b: 1, a: 2 }], { kind: "json", default: [{ a: 2, b: 1 }] }),
      ),
    ).toBe(false);
    expect(
      settingIsChanged(setting("llm.fallback_provider", null, { kind: "enum", default: null })),
    ).toBe(false);
  });

  test("a setting without a reported default is never counted as changed", () => {
    expect(settingIsChanged(setting("database.url", "postgres://x", { kind: "string" }))).toBe(
      false,
    );
  });

  test("a stored secret counts as changed; an empty one does not", () => {
    const secret = { kind: "string", sensitive: true, default: "" };
    expect(settingIsChanged(setting("llm.api_key", "***", secret))).toBe(true);
    expect(settingIsChanged(setting("llm.api_key", "", secret))).toBe(false);
    expect(settingIsChanged(setting("llm.api_key", null, secret))).toBe(false);
  });
});

describe("Geändert · Standard · Zurücksetzen", () => {
  const budget = setting("connectors.mcp.tools_list_max_pages", 500, {
    kind: "number",
    default: 0,
  });

  test("shows while the value on screen differs from the default", () => {
    expect(settingDiffersFromDefault(budget, undefined)).toBe(true);
    expect(settingDiffersFromDefault(budget, "0")).toBe(false);
    expect(settingDiffersFromDefault({ ...budget, value: 0 }, undefined)).toBe(false);
    expect(settingDiffersFromDefault({ ...budget, value: 0 }, "12")).toBe(true);
  });

  test("Zurücksetzen drafts the default as the field holds it", () => {
    expect(settingResetDraft(budget)).toBe("0");
    expect(
      settingResetDraft(setting("log.level", "debug", { kind: "enum", default: "info" })),
    ).toBe("info");
    expect(
      settingResetDraft(
        setting("llm.fallback_provider", "openai", { kind: "enum", default: null }),
      ),
    ).toBe("");
    expect(
      parseSettingDraft(setting("llm.fallback_provider", "openai", { kind: "enum" }), ""),
    ).toBeNull();
  });

  test("never for a secret, and never without a reported default", () => {
    const secret = setting("llm.api_key", "***", { kind: "string", sensitive: true, default: "" });
    expect(settingDiffersFromDefault(secret, undefined)).toBe(false);
    expect(settingResetDraft(secret)).toBeNull();
    const database = setting("database.url", "postgres://x", { kind: "string" });
    expect(settingResetDraft(database)).toBeNull();
    expect(settingDiffersFromDefault(database, undefined)).toBe(false);
  });

  test("names the default in words", () => {
    expect(settingValueText(false, de)).toBe("Aus");
    expect(settingValueText(null, de)).toBe(de("settings.unset"));
    expect(settingValueText("", de)).toBe("leer");
    expect(settingValueText(0, de)).toBe("0");
    expect(settingValueText("x".repeat(80), de)).toHaveLength(58);
  });
});

describe("a number draft", () => {
  const port = setting("server.port", 3000, { kind: "number", default: 3000 });

  test("is a number, and an empty or non-numeric draft is flagged, never a silent 0", () => {
    expect(parseSettingDraft(port, "3001")).toBe(3001);
    expect(parseSettingDraft(port, "")).toBeUndefined();
    expect(parseSettingDraft(port, "abc")).toBeUndefined();
    expect(settingDraftError(port, "")).toBe("settings.invalidNumber");
    expect(settingDraftError(port, "3001")).toBeNull();
  });

  test("carries its unit where the name says one", () => {
    expect(settingUnit("sandbox.wall_ms")).toBe("settings.unit.ms");
    expect(settingUnit("sandbox.memory_bytes")).toBe("settings.unit.bytes");
    expect(settingUnit("auth.mcp_oauth.access_token_ttl_seconds")).toBe("settings.unit.seconds");
    expect(settingUnit("notifications.push.thresholdSec")).toBe("settings.unit.seconds");
    expect(settingUnit("repl.portalTokenTtlMin")).toBe("settings.unit.minutes");
    expect(settingUnit("observability.usage.retention_days")).toBe("settings.unit.days");
    expect(settingUnit("queue.concurrency")).toBeNull();
  });
});

describe("one save", () => {
  const items = [
    setting("log.level", "info", { kind: "enum", default: "info" }),
    setting("connectors.mcp.tools_list_max_pages", 0, { kind: "number", default: 0 }),
    setting("llm.api_key", "***", { kind: "string", sensitive: true, default: "" }),
    setting("server.port", 3000, { kind: "number", default: 3000 }),
  ];

  const tenant = "5870ae6d-e542-48ca-bbcc-108b5ae73f5f";
  const scoped = [
    setting("log.level", "info", { kind: "enum", default: "info", scope: "global" }),
    setting("connectors.mcp.tools_list_max_pages", 0, {
      kind: "number",
      default: 0,
      scope: "tenant",
    }),
    setting("llm.api_key", "***", {
      kind: "string",
      sensitive: true,
      default: "",
      scope: "tenant",
    }),
  ];
  const none = { global: {}, tenant: {} };
  const drafts = (global: Record<string, string>, workspace: Record<string, string> = {}) => ({
    global,
    tenant: workspace,
  });

  test("global drafts are one patch against the revision the page was read at", () => {
    expect(
      settingsPatches(
        { saved_revision: 7, items },
        drafts({
          "log.level": "debug",
          "connectors.mcp.tools_list_max_pages": "500",
          "llm.api_key": "sk-new",
        }),
        { global: { "llm.api_key": "secret://settings.llm.api_key/3" }, tenant: {} },
        tenant,
      ),
    ).toEqual([
      {
        expected_revision: 7,
        scope: "global",
        changes: {
          "log.level": "debug",
          "connectors.mcp.tools_list_max_pages": 500,
          "llm.api_key": "secret://settings.llm.api_key/3",
        },
      },
    ]);
  });

  test("mixed drafts are one patch per scope, and a save only ever sends the first", () => {
    const patches = settingsPatches(
      { saved_revision: 7, items: scoped },
      drafts({ "log.level": "debug" }, { "connectors.mcp.tools_list_max_pages": "500" }),
      none,
      tenant,
    );
    expect(patches).toEqual([
      { expected_revision: 7, scope: "global", changes: { "log.level": "debug" } },
      {
        expected_revision: 7,
        scope: "tenant",
        tenant_id: tenant,
        changes: { "connectors.mcp.tools_list_max_pages": 500 },
      },
    ]);
    expect(nextSettingsSave(patches)).toEqual({ patch: patches[0]!, remaining: 1 });
    expect(nextSettingsSave([])).toBeNull();
  });

  test("a setting for the whole installation is never drafted for a workspace", () => {
    const item = scoped[0]!;
    expect(withSettingDraft(none, item, item.path, "debug", "tenant")).toEqual(
      drafts({ "log.level": "debug" }),
    );
    expect(
      settingsPatches(
        { saved_revision: 7, items: scoped },
        drafts({}, { "log.level": "debug" }),
        none,
        tenant,
      ),
    ).toEqual([]);
    expect(
      settingsPatches(
        { saved_revision: 7, items: scoped },
        drafts({}, { "connectors.mcp.tools_list_max_pages": "5" }),
        none,
        null,
      ),
    ).toEqual([]);
  });

  test("a workspace draft and a global draft of the same setting stay apart", () => {
    const budget = scoped[1]!;
    let state = withSettingDraft(none, budget, budget.path, "100", "tenant");
    state = withSettingDraft(state, budget, budget.path, "900", "global");
    expect(state).toEqual(
      drafts(
        { "connectors.mcp.tools_list_max_pages": "900" },
        { "connectors.mcp.tools_list_max_pages": "100" },
      ),
    );
    expect(settingDraftTexts(state, scoped, "global")).toEqual({
      "connectors.mcp.tools_list_max_pages": "900",
    });
    expect(settingDraftTexts(state, scoped, "tenant")).toEqual({
      "connectors.mcp.tools_list_max_pages": "100",
    });
    expect(withoutSettingDraft(state, budget, budget.path, "global")).toEqual(
      drafts({}, { "connectors.mcp.tools_list_max_pages": "100" }),
    );
    expect(changedSettings(scoped, state).map((entry) => entry.scope)).toEqual([
      "global",
      "tenant",
    ]);
  });

  test("an opened, still empty key field is a draft for its row but not a change to save", () => {
    const state = drafts({ "llm.api_key": "" });
    expect(settingDraftTexts(state, scoped, "global")).toEqual({ "llm.api_key": "" });
    expect(pendingSettingDrafts(scoped, state)).toEqual(none);
  });

  test("a workspace secret reference goes into the workspace patch", () => {
    const reference = `secret://tenants.${tenant}.settings.llm.api_key/1`;
    expect(
      settingsPatches(
        { saved_revision: 7, items: scoped },
        drafts({ "log.level": "debug" }, { "llm.api_key": "sk-new" }),
        { global: {}, tenant: { "llm.api_key": reference } },
        tenant,
      ),
    ).toEqual([
      { expected_revision: 7, scope: "global", changes: { "log.level": "debug" } },
      {
        expected_revision: 7,
        scope: "tenant",
        tenant_id: tenant,
        changes: { "llm.api_key": reference },
      },
    ]);
  });

  test("a secret's plaintext never enters the patch", () => {
    expect(() =>
      settingsPatches(
        { saved_revision: 7, items },
        drafts({ "llm.api_key": "sk-new" }),
        none,
        null,
      ),
    ).toThrow();
    expect(settingSecretName("llm.api_key")).toBe("settings.llm.api_key");
    expect(settingSecretName("llm.api_key", tenant)).toBe(`tenants.${tenant}.settings.llm.api_key`);
  });

  test("an invalid draft is not sent, and nothing is saved without a revision", () => {
    expect(() =>
      settingsPatches({ saved_revision: 7, items }, drafts({ "server.port": "" }), none, null),
    ).toThrow();
    expect(() =>
      settingsPatches(
        { saved_revision: null, items },
        drafts({ "log.level": "debug" }),
        none,
        null,
      ),
    ).toThrow();
  });

  test("activates the revision it saved", () => {
    expect(settingsActivationPath({ saved_revision: 8 })).toBe("/v1/settings/revisions/8/activate");
  });

  test("a 409 is somebody else's newer revision; anything else is a plain failure", () => {
    expect(settingsSaveFailure({ status: 409 })).toBe("conflict");
    expect(settingsSaveFailure({ status: 422 })).toBe("failed");
    expect(settingsSaveFailure(new Error("network"))).toBe("failed");
    expect(de("settings.conflict")).toBe(
      "Inzwischen hat jemand gespeichert – neu laden, deine Entwürfe bleiben.",
    );
  });

  test("a rejected value carries the engine's reason; other failures stay generic", () => {
    const reason =
      "llm.model 'claude-sonnet-4-6' is a anthropic model, but it would be sent to the openai provider.";
    expect(settingsSaveReason({ status: 422, message: reason })).toBe(reason);
    expect(settingsSaveReason({ status: 500, message: "boom" })).toBeNull();
    expect(settingsSaveReason(new Error("network"))).toBeNull();
  });
});

describe("a secret another secret stands in for", () => {
  const primary = setting("llm.api_key", "", { kind: "string", sensitive: true });
  const provider = setting("llm.provider", "anthropic", { kind: "enum" });
  const anthropic = setting("llm.providers.anthropic.api_key", "***", {
    kind: "string",
    sensitive: true,
  });

  test("the primary key is not missing when the active provider's key is stored", () => {
    expect(settingSecretCover(primary, [primary, provider, anthropic])).toBe(
      "llm.providers.anthropic.api_key",
    );
  });

  test("it is missing when neither is stored", () => {
    const empty = { ...anthropic, value: "" };
    expect(settingSecretCover(primary, [primary, provider, empty])).toBeNull();
  });

  test("a stored primary key needs no stand-in, and no other secret has one", () => {
    expect(settingSecretCover({ ...primary, value: "***" }, [provider, anthropic])).toBeNull();
    expect(settingSecretCover(anthropic, [primary, provider, anthropic])).toBeNull();
  });

  test("the row says which setting stands in", () => {
    expect(
      de("settings.secret.covered", {
        setting: settingLabel("llm.providers.anthropic.api_key", de).text,
      }),
    ).toBe("Nicht nötig · Anthropic · API-Schlüssel ist hinterlegt");
  });
});
