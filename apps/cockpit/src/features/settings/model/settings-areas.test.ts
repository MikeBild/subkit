import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  areaStatus,
  FIRST_SETTINGS_LEVEL,
  SETTING_AREA_IDS,
  SETTING_AREAS,
  type SettingAreaId,
  settingAreaOf,
  settingsLevelFromUrl,
  shownInCockpit,
} from "./settings-areas";
import type { SettingItem } from "./settings-model";
import { settingSectionOf } from "./settings-model";

const WALK = resolve(import.meta.dir, "../../../../../engine/src/config/walk.ts");
const { listConfigLeaves } = (await import(WALK)) as {
  listConfigLeaves(): Array<{ path: string[] }>;
};
const PATHS = listConfigLeaves().map((leaf) => leaf.path.join("."));

function item(path: string, value: unknown, sensitive = false): SettingItem {
  return {
    path,
    value,
    meta: { source: "default", scope: "tenant", sensitive, requiresRestart: false, kind: "string" },
  };
}

describe("settings areas", () => {
  test("every Cockpit section belongs to exactly one area", () => {
    expect(PATHS.length).toBeGreaterThan(100);
    const sections = new Set(PATHS.filter(shownInCockpit).map(settingSectionOf));
    for (const section of sections) {
      const owners = SETTING_AREAS.filter((area) => area.sections.includes(section));
      expect(
        owners.map((area) => area.id),
        section,
      ).toHaveLength(1);
    }
  });

  test("the AI section and the token budget belong to the assistant", () => {
    expect(settingAreaOf("llm.model")).toBe("ai");
    expect(settingAreaOf("tokens.prices")).toBe("ai");
  });

  test("deep links open the full list, every area has its own address, and the bare page opens general", () => {
    expect(settingsLevelFromUrl("?leaf=llm.model").kind).toBe("all");
    expect(settingsLevelFromUrl("?section=llm").kind).toBe("all");
    expect(settingsLevelFromUrl("?filter=changed").kind).toBe("all");
    expect(settingsLevelFromUrl("?view=all").kind).toBe("all");
    expect(settingsLevelFromUrl("?area=ai")).toEqual({ kind: "area", area: "ai" });
    expect(settingsLevelFromUrl("?area=costs")).toEqual(FIRST_SETTINGS_LEVEL);
    expect(settingsLevelFromUrl("?area=people&section=roles")).toEqual({
      kind: "area",
      area: "people",
    });
    expect(settingsLevelFromUrl("?area=profile")).toEqual({ kind: "area", area: "profile" });
    expect(settingsLevelFromUrl("?area=workspace")).toEqual({ kind: "area", area: "workspace" });
    expect(settingsLevelFromUrl("?tab=notifications")).toEqual({
      kind: "area",
      area: "notifications",
    });
    expect(settingsLevelFromUrl("?area=nope")).toEqual(FIRST_SETTINGS_LEVEL);
    expect(settingsLevelFromUrl("")).toEqual(FIRST_SETTINGS_LEVEL);
  });

  test("status comes from facts: a missing key waits and a pending restart wins", () => {
    const facts = (items: SettingItem[], pendingRestart: string[] = []) => ({
      items,
      pendingRestart,
    });
    const openai = [
      item("llm.provider", "openai"),
      item("llm.providers.openai.api_key", null, true),
      item("llm.api_key", null, true),
    ];
    expect(areaStatus("ai", facts(openai))).toBe("waiting");
    expect(areaStatus("ai", facts([item("llm.provider", null)]))).toBe("waiting");
    expect(
      areaStatus(
        "ai",
        facts([item("llm.provider", "openai"), item("llm.providers.openai.api_key", "***", true)]),
      ),
    ).toBe("configured");
    expect(
      areaStatus(
        "ai",
        facts([
          item("llm.provider", "openai"),
          item("llm.providers.openai.api_key", null, true),
          item("llm.api_key", "***", true),
        ]),
      ),
    ).toBe("configured");
    expect(areaStatus("ai", facts(openai, ["llm.fallback_provider"]))).toBe("restart");
    expect(areaStatus("operations", facts([], ["llm.fallback_provider"]))).toBe("restart");
    expect(areaStatus("access", facts([]))).toBeNull();
  });
});

describe("guided drafts the save bar has to refuse", () => {
  const items = [item("llm.provider", "openai")];
  test("the replacement differs from the provider", async () => {
    const { settingsGuidedErrors } = await import("./settings-areas");
    expect(settingsGuidedErrors(items, { "llm.fallback_provider": "openai" })).toEqual([
      "llm.fallback_provider",
    ]);
    expect(settingsGuidedErrors(items, { "llm.fallback_provider": "anthropic" })).toEqual([]);
  });
});

describe("the workspace scope", () => {
  test("belongs to the page that offers it and is global everywhere else", async () => {
    const { pageScope } = await import("./settings-areas");
    const chosen = { ai: "tenant" } as const;
    expect(pageScope({ kind: "area", area: "ai" }, true, chosen, null)).toBe("tenant");
    for (const area of ["access", "connections", "notifications", "operations"] as const)
      expect(pageScope({ kind: "area", area }, true, chosen, null)).toBe("global");
    expect(pageScope({ kind: "area", area: "profile" }, true, chosen, null)).toBe("global");
    expect(pageScope({ kind: "area", area: "ai" }, false, chosen, null)).toBe("global");
  });

  test("opens for this workspace when it has its own value on the page, until someone picks", async () => {
    const { pageScope } = await import("./settings-areas");
    const own = (path: string, value: unknown): SettingItem => ({
      ...item(path, value),
      meta: { ...item(path, value).meta, source: "tenant" },
    });
    const tenantItems = [
      own("llm.provider", "anthropic"),
      item("connectors.mcp.tools_list_max_pages", 0),
    ];
    expect(pageScope({ kind: "area", area: "ai" }, true, {}, tenantItems)).toBe("tenant");
    expect(
      pageScope({ kind: "area", area: "ai" }, true, {}, [
        own("connectors.mcp.tools_list_max_pages", 1000),
      ]),
    ).toBe("global");
    expect(pageScope({ kind: "area", area: "ai" }, true, { ai: "global" }, tenantItems)).toBe(
      "global",
    );
    expect(pageScope({ kind: "area", area: "ai" }, false, {}, tenantItems)).toBe("global");
  });
});

describe("who sees which area", () => {
  const ENGINE = ["ai", "access", "connections", "notifications", "operations"] as const;
  const BASE = ["profile", "setup", "devices", "rules", "vault", "help"] as const;
  const listed = (...ids: readonly SettingAreaId[]) =>
    SETTING_AREA_IDS.filter((id) => ids.includes(id));
  const see = async (
    permissions: string[],
    origin: "self_hosted" | "self_service",
    isOwner = false,
  ) => {
    const { visibleSettingAreas } = await import("./settings-areas");
    return visibleSettingAreas({ permissions, origin, isOwner });
  };

  test("the fixed list follows the click-dummy and ends with help", () => {
    expect(SETTING_AREA_IDS).toEqual([
      "profile",
      "setup",
      "people",
      "notifications",
      "devices",
      "updates",
      "privacy",
      "rules",
      "vault",
      "usage",
      "workspace",
      "ai",
      "access",
      "connections",
      "operations",
      "help",
    ]);
  });

  test("updates and privacy exist only inside the desktop app", async () => {
    const { visibleSettingAreas } = await import("./settings-areas");
    const access = { permissions: [], origin: "self_service", isOwner: false } as const;
    expect(visibleSettingAreas(access)).not.toContain("updates");
    expect(visibleSettingAreas(access, true)).toEqual(listed(...BASE, "updates", "privacy"));
  });

  test("everybody has general, setup, devices, rules, the vault and help, and nothing else without a right", async () => {
    expect(await see([], "self_service")).toEqual(listed(...BASE));
    expect(await see([], "self_hosted")).toEqual(listed(...BASE));
  });

  test("people show for whoever reads people, roles or settings", async () => {
    for (const permission of ["identity:read", "rbac:read", "settings:read"])
      expect(await see([permission], "self_service")).toContain("people");
    expect(await see(["workflow:read"], "self_service")).not.toContain("people");
  });

  test("usage, with its amounts, belongs to those who may read the usage figures", async () => {
    expect(await see(["stats:read"], "self_service")).toEqual(listed(...BASE, "usage"));
    expect(await see([], "self_service")).not.toContain("usage");
  });

  test("the workspace belongs to its owner and to those who manage people", async () => {
    expect(await see([], "self_hosted", true)).toEqual(listed(...BASE, "workspace"));
    expect(await see(["identity:write"], "self_hosted")).toEqual(listed(...BASE, "workspace"));
    expect(await see(["identity:read"], "self_service")).toEqual(listed(...BASE, "people"));
  });

  test("a hosted workspace's AI access belongs to its owner and its administrators", async () => {
    expect(await see([], "self_service", true)).toEqual(listed(...BASE, "workspace", "ai"));
    expect(await see(["identity:write"], "self_service")).toEqual(
      listed(...BASE, "workspace", "ai"),
    );
    const { workspaceAiEditable } = await import("./settings-areas");
    expect(workspaceAiEditable({ permissions: [], origin: "self_hosted", isOwner: true })).toBe(
      false,
    );
    expect(
      workspaceAiEditable({
        permissions: ["settings:write:global"],
        origin: "self_service",
        isOwner: true,
      }),
    ).toBe(false);
  });

  test("a hosted owner sees workspace, AI access and notifications, and no engine area", async () => {
    const owner = ["settings:read", "settings:write", "notification:read", "identity:write"];
    expect(await see(owner, "self_service", true)).toEqual(
      listed(...BASE, "people", "workspace", "ai", "notifications"),
    );
  });

  test("a hosted member sees only what is their own, whatever settings right the role carries", async () => {
    const member = ["settings:read", "settings:write", "workflow:read", "conversation:read"];
    expect(await see(member, "self_service")).toEqual(listed(...BASE, "people"));
  });

  test("whoever can change the engine sees its areas, in either kind of workspace", async () => {
    for (const origin of ["self_hosted", "self_service"] as const)
      expect(await see(["settings:read", "settings:write:global"], origin)).toEqual(
        listed(...BASE, "people", ...ENGINE),
      );
  });

  test("a self-hosted reader keeps the engine areas to look at", async () => {
    expect(await see(["settings:read"], "self_hosted")).toEqual(
      listed(...BASE, "people", ...ENGINE),
    );
    const { engineSettingsAccess } = await import("./settings-areas");
    expect(
      engineSettingsAccess({
        permissions: ["settings:read"],
        origin: "self_hosted",
        isOwner: false,
      }),
    ).toBe("read");
    expect(
      engineSettingsAccess({
        permissions: ["settings:read"],
        origin: "self_service",
        isOwner: true,
      }),
    ).toBe("none");
  });

  test("notifications alone show for whoever reads rules and channels", async () => {
    expect(await see(["notification:read"], "self_service")).toEqual(
      listed(...BASE, "notifications"),
    );
  });

  test("a deep link to a hidden area or to the full list falls back to general", async () => {
    const { openSettingsLevel } = await import("./settings-areas");
    const hosted = {
      permissions: ["settings:read"],
      origin: "self_service",
      isOwner: true,
    } as const;
    expect(openSettingsLevel({ kind: "area", area: "operations" }, hosted)).toEqual(
      FIRST_SETTINGS_LEVEL,
    );
    expect(openSettingsLevel(settingsLevelFromUrl("?leaf=llm.model"), hosted)).toEqual(
      FIRST_SETTINGS_LEVEL,
    );
    expect(openSettingsLevel({ kind: "area", area: "workspace" }, hosted)).toEqual({
      kind: "area",
      area: "workspace",
    });
    expect(openSettingsLevel({ kind: "area", area: "ai" }, hosted)).toEqual({
      kind: "area",
      area: "ai",
    });
    const member = { permissions: [], origin: "self_service", isOwner: false } as const;
    expect(openSettingsLevel({ kind: "area", area: "workspace" }, member)).toEqual(
      FIRST_SETTINGS_LEVEL,
    );
    expect(openSettingsLevel({ kind: "area", area: "ai" }, member)).toEqual(FIRST_SETTINGS_LEVEL);
    const operator = {
      permissions: ["settings:read", "settings:write:global"],
      origin: "self_hosted",
      isOwner: false,
    } as const;
    expect(openSettingsLevel({ kind: "area", area: "operations" }, operator)).toEqual({
      kind: "area",
      area: "operations",
    });
    expect(openSettingsLevel(settingsLevelFromUrl("?view=all"), operator).kind).toBe("all");
  });
});
