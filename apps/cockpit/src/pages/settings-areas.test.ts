import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  areaStatus,
  SETTING_AREAS,
  settingAreaOf,
  settingsLevelFromUrl,
} from "@/pages/settings-areas";
import type { SettingItem } from "@/pages/settings-model";
import { settingSectionOf } from "@/pages/settings-model";

const WALK = resolve(import.meta.dir, "../../../engine/src/config/walk.ts");
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
  test("every engine section belongs to exactly one area", () => {
    expect(PATHS.length).toBeGreaterThan(100);
    const sections = new Set(PATHS.map(settingSectionOf));
    for (const section of sections) {
      const owners = SETTING_AREAS.filter((area) => area.sections.includes(section));
      expect(
        owners.map((area) => area.id),
        section,
      ).toHaveLength(1);
    }
  });

  test("hosted AI budgets belong to costs, the rest of the AI section to the assistant", () => {
    expect(settingAreaOf("llm.hosted.tenant_monthly_microunits")).toBe("costs");
    expect(settingAreaOf("llm.model")).toBe("ai");
    expect(settingAreaOf("tokens.prices")).toBe("costs");
  });

  test("deep links open the full list; areas and the overview have their own address", () => {
    expect(settingsLevelFromUrl("?leaf=llm.model").kind).toBe("all");
    expect(settingsLevelFromUrl("?section=llm").kind).toBe("all");
    expect(settingsLevelFromUrl("?filter=changed").kind).toBe("all");
    expect(settingsLevelFromUrl("?view=all").kind).toBe("all");
    expect(settingsLevelFromUrl("?area=costs")).toEqual({ kind: "area", area: "costs" });
    expect(settingsLevelFromUrl("?area=profile")).toEqual({ kind: "area", area: "profile" });
    expect(settingsLevelFromUrl("?area=workspace")).toEqual({ kind: "area", area: "workspace" });
    expect(settingsLevelFromUrl("?tab=notifications")).toEqual({
      kind: "area",
      area: "notifications",
    });
    expect(settingsLevelFromUrl("?area=nope")).toEqual({ kind: "overview" });
    expect(settingsLevelFromUrl("")).toEqual({ kind: "overview" });
  });

  test("status comes from facts: a missing key waits, a pending restart wins, no limit is quiet", () => {
    const facts = (items: SettingItem[], pendingRestart: string[] = []) => ({
      items,
      pendingRestart,
      budgetConsumedShare: null,
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
    expect(areaStatus("costs", facts([item("tokens.monthly_budget", 0)]))).toBeNull();
    expect(areaStatus("costs", facts([item("tokens.monthly_budget", 1000)]))).toBe("configured");
    expect(
      areaStatus("costs", {
        items: [item("tokens.monthly_budget", 1000)],
        pendingRestart: [],
        budgetConsumedShare: 1,
      }),
    ).toBe("limit");
    expect(areaStatus("access", facts([]))).toBeNull();
  });
});

describe("guided drafts the save bar has to refuse", () => {
  const items = [item("llm.provider", "openai")];
  const draft = (text: string) => text;
  test("hosted amounts are microunit strings, budgets whole numbers, the replacement differs", async () => {
    const { settingsGuidedErrors } = await import("@/pages/settings-areas");
    expect(
      settingsGuidedErrors(items, {
        "llm.hosted.tenant_monthly_microunits": draft("0,5"),
        "llm.hosted.global_monthly_microunits": draft("12500000"),
        "tokens.monthly_budget": draft("1.5"),
        "llm.fallback_provider": draft("openai"),
      }),
    ).toEqual([
      "llm.hosted.tenant_monthly_microunits",
      "tokens.monthly_budget",
      "llm.fallback_provider",
    ]);
    expect(
      settingsGuidedErrors(items, {
        "llm.fallback_provider": draft("anthropic"),
        "tokens.monthly_budget": draft("1000000"),
      }),
    ).toEqual([]);
  });
});

describe("hosted amounts and sign-in names", () => {
  test("a hosted budget of 0 is refused, because it blocks every paid call", async () => {
    const { settingsGuidedErrors } = await import("@/pages/settings-areas");
    expect(
      settingsGuidedErrors([], {
        "llm.hosted.global_monthly_microunits": "0",
        "llm.hosted.tenant_monthly_microunits": "1",
      }),
    ).toEqual(["llm.hosted.global_monthly_microunits"]);
  });

  test("the overview names the API-key sign-in in the reader's words, not its stored label", async () => {
    const { authMethodNames } = await import("@/pages/settings-areas");
    const providers = item("auth.providers", [
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
      { protocol: "oidc", id: "google", label: "Google" },
    ]);
    expect(authMethodNames([providers], "API-Schlüssel")).toEqual(["API-Schlüssel", "Google"]);
  });
});

describe("the workspace scope", () => {
  test("belongs to the page that offers it and is global everywhere else", async () => {
    const { pageScope } = await import("@/pages/settings-areas");
    const chosen = { ai: "tenant", costs: "global" } as const;
    expect(pageScope({ kind: "area", area: "ai" }, true, chosen, null)).toBe("tenant");
    expect(pageScope({ kind: "area", area: "costs" }, true, chosen, null)).toBe("global");
    for (const area of ["access", "connections", "notifications", "operations"] as const)
      expect(pageScope({ kind: "area", area }, true, chosen, null)).toBe("global");
    expect(pageScope({ kind: "overview" }, true, chosen, null)).toBe("global");
    expect(pageScope({ kind: "area", area: "ai" }, false, chosen, null)).toBe("global");
  });

  test("opens for this workspace when it has its own value on the page, until someone picks", async () => {
    const { pageScope } = await import("@/pages/settings-areas");
    const own = (path: string, value: unknown): SettingItem => ({
      ...item(path, value),
      meta: { ...item(path, value).meta, source: "tenant" },
    });
    const tenantItems = [own("llm.provider", "anthropic"), item("tokens.monthly_budget", 0)];
    expect(pageScope({ kind: "area", area: "ai" }, true, {}, tenantItems)).toBe("tenant");
    expect(pageScope({ kind: "area", area: "costs" }, true, {}, tenantItems)).toBe("global");
    expect(pageScope({ kind: "area", area: "ai" }, true, { ai: "global" }, tenantItems)).toBe(
      "global",
    );
    expect(pageScope({ kind: "area", area: "ai" }, false, {}, tenantItems)).toBe("global");
  });
});

describe("the AI overview sentence", () => {
  const sentenceFacts = (items: SettingItem[]) => ({
    items,
    pendingRestart: [],
    budgetConsumedShare: null,
    canWrite: true,
    providerName: (provider: string) => (provider === "openai" ? "OpenAI" : "Anthropic"),
    modelName: (_provider: string, model: string) => model || "Standardmodell von OpenAI",
    budgetText: (tokens: number) => String(tokens),
    spentText: null,
    resetDate: "",
    apiKeyName: "API-Schlüssel",
  });

  test("names the provider's default model without repeating the provider", async () => {
    const { areaSentences } = await import("@/pages/settings-areas");
    const base = [item("llm.provider", "openai"), item("llm.model", "")];
    expect(areaSentences("ai", sentenceFacts(base))).toEqual([
      { key: "settings.overview.ai.defaultModelNoFallback", values: { provider: "OpenAI" } },
    ]);
    expect(
      areaSentences("ai", sentenceFacts([...base, item("llm.fallback_provider", "anthropic")])),
    ).toEqual([
      {
        key: "settings.overview.ai.defaultModelWithFallback",
        values: { provider: "OpenAI", fallbackProvider: "Anthropic" },
      },
    ]);
  });

  test("keeps the chosen model in the sentence", async () => {
    const { areaSentences } = await import("@/pages/settings-areas");
    expect(
      areaSentences(
        "ai",
        sentenceFacts([item("llm.provider", "openai"), item("llm.model", "GPT-4.1 mini")]),
      ),
    ).toEqual([
      {
        key: "settings.overview.ai.noFallback",
        values: { provider: "OpenAI", model: "GPT-4.1 mini" },
      },
    ]);
  });
});

describe("who sees which area", () => {
  const ENGINE = ["ai", "costs", "access", "connections", "notifications", "operations"] as const;
  const see = async (
    permissions: string[],
    origin: "self_hosted" | "self_service",
    isOwner = false,
  ) => {
    const { visibleSettingAreas } = await import("@/pages/settings-areas");
    return visibleSettingAreas({ permissions, origin, isOwner });
  };

  test("everybody has a profile, and nothing else without a right", async () => {
    expect(await see([], "self_service")).toEqual(["profile"]);
    expect(await see([], "self_hosted")).toEqual(["profile"]);
  });

  test("the workspace belongs to its owner and to those who manage people", async () => {
    expect(await see([], "self_hosted", true)).toEqual(["profile", "workspace"]);
    expect(await see(["identity:write"], "self_hosted")).toEqual(["profile", "workspace"]);
    expect(await see(["identity:read"], "self_service")).toEqual(["profile"]);
  });

  test("a hosted workspace's AI access belongs to its owner and its administrators", async () => {
    expect(await see([], "self_service", true)).toEqual(["profile", "workspace", "ai"]);
    expect(await see(["identity:write"], "self_service")).toEqual(["profile", "workspace", "ai"]);
    const { workspaceAiEditable } = await import("@/pages/settings-areas");
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

  test("a hosted owner sees profile, workspace, AI access and notifications, and no engine area", async () => {
    const owner = ["settings:read", "settings:write", "notification:read", "identity:write"];
    expect(await see(owner, "self_service", true)).toEqual([
      "profile",
      "workspace",
      "ai",
      "notifications",
    ]);
  });

  test("a hosted member sees the profile only, whatever settings right the role carries", async () => {
    const member = ["settings:read", "settings:write", "workflow:read", "conversation:read"];
    expect(await see(member, "self_service")).toEqual(["profile"]);
  });

  test("whoever can change the engine sees its areas, in either kind of workspace", async () => {
    for (const origin of ["self_hosted", "self_service"] as const)
      expect(await see(["settings:read", "settings:write:global"], origin)).toEqual([
        "profile",
        ...ENGINE,
      ]);
  });

  test("a self-hosted reader keeps the engine areas to look at", async () => {
    expect(await see(["settings:read"], "self_hosted")).toEqual(["profile", ...ENGINE]);
    const { engineSettingsAccess } = await import("@/pages/settings-areas");
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
    expect(await see(["notification:read"], "self_service")).toEqual(["profile", "notifications"]);
  });

  test("a deep link to a hidden area or to the full list falls back to the overview", async () => {
    const { openSettingsLevel } = await import("@/pages/settings-areas");
    const hosted = {
      permissions: ["settings:read"],
      origin: "self_service",
      isOwner: true,
    } as const;
    expect(openSettingsLevel({ kind: "area", area: "operations" }, hosted)).toEqual({
      kind: "overview",
    });
    expect(openSettingsLevel(settingsLevelFromUrl("?leaf=llm.model"), hosted)).toEqual({
      kind: "overview",
    });
    expect(openSettingsLevel({ kind: "area", area: "workspace" }, hosted)).toEqual({
      kind: "area",
      area: "workspace",
    });
    expect(openSettingsLevel({ kind: "area", area: "ai" }, hosted)).toEqual({
      kind: "area",
      area: "ai",
    });
    const member = { permissions: [], origin: "self_service", isOwner: false } as const;
    expect(openSettingsLevel({ kind: "area", area: "workspace" }, member)).toEqual({
      kind: "overview",
    });
    expect(openSettingsLevel({ kind: "area", area: "ai" }, member)).toEqual({ kind: "overview" });
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
