// What the installation pages call a role, a permission and a setting's source.
//
// Each of these answered "Unbekannt" for a value it had no word for. §2 bans
// the word; §15.2 names the replacement — the machine value, recognisably as
// such. These pin both halves: the named case stays prose, the rest is the
// engine's own value flagged as one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { settingsHref } from "@/app/links";
import { translate } from "@/lib/i18n";
import {
  activationStatusLabel,
  assignableRoles,
  permissionLabel,
  personRefusal,
  roleChange,
  roleChangeNotes,
  roleLabel,
  roleName,
  settingLabel,
  settingLeafTarget,
  settingMetaLabel,
  settingSectionOf,
  settingsLeafFromUrl,
  settingsViewFromUrl,
} from "@/pages/admin-model";

const query = (href: string) => href.slice(href.indexOf("?"));

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);

describe("roles", () => {
  test("a built-in role is named", () => {
    expect(roleLabel("admin", de)).toEqual({ text: de("role.admin"), machine: false });
  });

  test("a role this build has no word for is shown as the machine value, not as unknown", () => {
    expect(roleLabel("auditor", de)).toEqual({ text: "auditor", machine: true });
    expect(roleLabel("auditor", de).text).not.toBe(de("common.unknown"));
  });
});

describe("permissions", () => {
  test("a known resource and action read as one phrase", () => {
    const label = permissionLabel("workflow:run", de);
    expect(label.machine).toBe(false);
    expect(label.text).toBe(
      de("permission.label", {
        resource: de("resource.workflows.title"),
        action: de("permission.action.run"),
      }),
    );
  });

  test("a half this build cannot name keeps the whole token", () => {
    // Showing "Workflows: frobnicate" would invent half a sentence; the
    // token is what an operator can look up.
    expect(permissionLabel("workflow:frobnicate", de)).toEqual({
      text: "workflow:frobnicate",
      machine: true,
    });
    expect(permissionLabel("telemetry:read", de)).toEqual({
      text: "telemetry:read",
      machine: true,
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

// Every permission the engine can hold, named — read from the engine's own
// catalogue, so a permission added there without a name here fails this file.
const ENGINE_PERMISSIONS = (
  JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../engine/src/rbac/permissions.json"), "utf8"),
  ) as Array<{ name: string; resource_type: string }>
).map((entry) => entry.name);

describe("the engine's permission catalogue", () => {
  test("is read (a moved file must not turn this into a vacuous pass)", () => {
    expect(ENGINE_PERMISSIONS.length).toBeGreaterThan(50);
  });

  for (const locale of ["de", "en"] as const) {
    const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
      translate(locale, key, values);

    test(`every permission has a ${locale} name`, () => {
      const unnamed = ENGINE_PERMISSIONS.filter((name) => permissionLabel(name, t).machine);
      expect(unnamed).toEqual([]);
    });

    test(`no two permissions share a ${locale} name`, () => {
      // `stats:read:all` and `stats:read` are two rights; a two-part split
      // named them the same.
      const seen = new Map<string, string>();
      for (const name of ENGINE_PERMISSIONS) {
        const text = permissionLabel(name, t).text;
        expect(seen.get(text), `${name} reads like ${seen.get(text)}`).toBeUndefined();
        seen.set(text, name);
      }
    });

    test(`no ${locale} name is a word for unknown`, () => {
      for (const name of ENGINE_PERMISSIONS)
        expect(permissionLabel(name, t).text).not.toContain(t("common.unknown"));
    });
  }
});

describe("roles a person holds", () => {
  const roles = [
    { id: "r-admin", name: "admin", is_builtin: true },
    { id: "r-member", name: "member", is_builtin: true },
    { id: "r-enduser", name: "enduser", is_builtin: true },
    { id: "r-metrics", name: "metrics_scraper", is_builtin: true },
    { id: "r-portal", name: "portal_token_user", is_builtin: true },
    { id: "r-auditor", name: "Revision", is_builtin: false },
    { id: "r-analyst", name: "Analyst", is_builtin: false },
  ];

  test("a custom role is named by its own name, as prose", () => {
    expect(roleName("Revision", roles, de)).toEqual({ text: "Revision", machine: false });
  });

  test("a built-in role is named in the reader's language", () => {
    expect(roleName("admin", roles, de)).toEqual({ text: de("role.admin"), machine: false });
  });

  test("a role nobody defined stays the machine value", () => {
    expect(roleName("ghost", roles, de)).toEqual({ text: "ghost", machine: true });
  });

  test("a person may hold the person roles and every custom role — not machine roles", () => {
    expect(assignableRoles(roles).map((role) => role.name)).toEqual([
      "admin",
      "member",
      "enduser",
      "Analyst",
      "Revision",
    ]);
  });

  test("a role change says what is gained and what is lost", () => {
    expect(roleChange(["workflow:read", "workflow:run"], ["workflow:read", "rbac:write"])).toEqual({
      gained: ["rbac:write"],
      lost: ["workflow:run"],
    });
    expect(roleChange(["a"], ["a"])).toEqual({ gained: [], lost: [] });
  });
});

describe("the settings view a link opens", () => {
  test("a leaf opens the tab it lives on", () => {
    expect(settingSectionOf("tokens.monthly_budget")).toBe("tokens");
    expect(settingSectionOf("llm")).toBe("llm");
  });

  test("the address carries leaf, tab and search, and drops junk", () => {
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

  test("the activation state is a word, and an unknown one is the machine value", () => {
    expect(activationStatusLabel("restart_required", de)).toEqual({
      text: de("settings.activation.restartRequired"),
      machine: false,
    });
    expect(activationStatusLabel(null, de).machine).toBe(false);
    expect(activationStatusLabel("rolling", de)).toEqual({ text: "rolling", machine: true });
  });
});

describe("what a role change says beyond its permissions", () => {
  test("leaving admin always says people and role management go with it", () => {
    // Admin-only routes check the role NAME: a custom role with every
    // permission is still not "admin", so "the rights stay the same" was false.
    expect(roleChangeNotes({ from: "admin", to: "Revision", isSelf: false })).toEqual([
      "leavesAdmin",
    ]);
    expect(roleChangeNotes({ from: "admin", to: "member", isSelf: true })).toEqual([
      "selfLeavesAdmin",
    ]);
    expect(roleChangeNotes({ from: "member", to: "Revision", isSelf: true })).toEqual(["self"]);
    expect(roleChangeNotes({ from: "member", to: "admin", isSelf: false })).toEqual([]);
  });

  test("a refusal says why — the last administrator in words", () => {
    expect(personRefusal({ code: "last_admin", message: "x" }, de)).toBe(
      de("people.refusal.lastAdmin"),
    );
    expect(personRefusal({ code: "teapot", message: "short and stout" }, de)).toBe(
      de("people.refusal.engine", { reason: "short and stout" }),
    );
    expect(personRefusal(null, de)).toBe(de("people.roleUpdateFailed"));
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

  test("an unreported activation state is said as such, not as active", () => {
    expect(activationStatusLabel(null, de).text).toBe(de("settings.activation.unreported"));
    expect(activationStatusLabel(null, de).text).not.toBe(de("settings.activation.active"));
  });
});
