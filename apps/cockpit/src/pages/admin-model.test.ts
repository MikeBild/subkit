// What the installation pages call a role, a permission and a setting's source.
//
// Each of these answered "Unbekannt" for a value it had no word for. §2 bans
// the word; §15.2 names the replacement — the machine value, recognisably as
// such. These pin both halves: the named case stays prose, the rest is the
// engine's own value flagged as one.

import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  permissionLabel,
  roleLabel,
  settingMetaLabel,
  settingsLeafFromUrl,
} from "@/pages/admin-model";

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
