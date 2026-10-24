import type { TranslationKey } from "@/lib/i18n";
import {
  type SettingItem,
  type SettingsView,
  settingSecretStored,
  settingSectionOf,
  settingsViewFromUrl,
} from "@/pages/settings-model";

export const SETTING_AREA_IDS = [
  "ai",
  "costs",
  "access",
  "connections",
  "notifications",
  "operations",
] as const;
export type SettingAreaId = (typeof SETTING_AREA_IDS)[number];

export const SETTING_AREAS: readonly { id: SettingAreaId; sections: readonly string[] }[] = [
  { id: "ai", sections: ["llm"] },
  { id: "costs", sections: ["tokens"] },
  { id: "access", sections: ["auth", "products", "mcp", "egress", "spec"] },
  { id: "connections", sections: ["connectors", "platform", "storage"] },
  { id: "notifications", sections: ["notifications"] },
  {
    id: "operations",
    sections: [
      "server",
      "database",
      "log",
      "errors",
      "operations",
      "observability",
      "queue",
      "sandbox",
      "repl",
      "ui",
      "branding",
    ],
  },
];

export const HOSTED_LLM_PREFIX = "llm.hosted.";

export function isSettingArea(value: string | null | undefined): value is SettingAreaId {
  return SETTING_AREA_IDS.includes(value as SettingAreaId);
}

export function settingAreaOfSection(section: string): SettingAreaId {
  return SETTING_AREAS.find((area) => area.sections.includes(section))?.id ?? "operations";
}

export function settingAreaOf(path: string): SettingAreaId {
  if (path.startsWith(HOSTED_LLM_PREFIX)) return "costs";
  return settingAreaOfSection(settingSectionOf(path));
}

export type SettingsLevel =
  | { kind: "overview" }
  | { kind: "area"; area: SettingAreaId }
  | { kind: "all"; view: SettingsView };

export function settingsLevelFromUrl(search: string): SettingsLevel {
  const params = new URLSearchParams(search);
  const view = settingsViewFromUrl(search);
  if (
    view.leaf ||
    view.section ||
    params.get("filter") === "changed" ||
    params.get("view") === "all"
  )
    return { kind: "all", view };
  const area = params.get("area");
  if (isSettingArea(area)) return { kind: "area", area };
  if (params.get("tab") === "notifications") return { kind: "area", area: "notifications" };
  return { kind: "overview" };
}

export const SCOPED_AREAS = ["ai", "costs"] as const;
export type ScopedArea = (typeof SCOPED_AREAS)[number];

export function scopedAreaOf(level: SettingsLevel): ScopedArea | null {
  return level.kind === "area" && (SCOPED_AREAS as readonly string[]).includes(level.area)
    ? (level.area as ScopedArea)
    : null;
}

export function workspaceHasOwnValue(
  area: ScopedArea,
  tenantItems: readonly SettingItem[] | null,
): boolean {
  return (tenantItems ?? []).some(
    (item) => item.meta.source === "tenant" && settingAreaOf(item.path) === area,
  );
}

export function pageScope(
  level: SettingsLevel,
  scopeAvailable: boolean,
  chosen: Readonly<Partial<Record<ScopedArea, "global" | "tenant">>>,
  tenantItems: readonly SettingItem[] | null,
): "global" | "tenant" {
  const area = scopedAreaOf(level);
  if (!scopeAvailable || !area) return "global";
  return chosen[area] ?? (workspaceHasOwnValue(area, tenantItems) ? "tenant" : "global");
}

export type AreaStatus = "configured" | "waiting" | "restart" | "limit";

export interface AreaFacts {
  items: readonly SettingItem[];
  pendingRestart: readonly string[];
  budgetConsumedShare: number | null;
}

function itemValue(items: readonly SettingItem[], path: string): unknown {
  return items.find((item) => item.path === path)?.value;
}

function stringValue(items: readonly SettingItem[], path: string): string {
  const value = itemValue(items, path);
  return typeof value === "string" ? value : "";
}

export function providerKeyPath(provider: string): string {
  return `llm.providers.${provider}.api_key`;
}

export function providerKeyState(
  items: readonly SettingItem[],
  provider: string,
  primary: boolean,
): "stored" | "missing" | "none" {
  const key = items.find((item) => item.path === providerKeyPath(provider));
  if (!key) return "none";
  if (settingSecretStored(key)) return "stored";
  const generalKey = primary ? items.find((item) => item.path === "llm.api_key") : undefined;
  return generalKey && settingSecretStored(generalKey) ? "stored" : "missing";
}

export function areaRestartFields(area: SettingAreaId, pending: readonly string[]): string[] {
  return pending.filter((path) => settingAreaOf(path) === area);
}

export function areaStatus(area: SettingAreaId, facts: AreaFacts): AreaStatus | null {
  const restart =
    area === "operations" ? facts.pendingRestart : areaRestartFields(area, facts.pendingRestart);
  if (restart.length > 0) return "restart";
  if (area === "ai") {
    const provider = stringValue(facts.items, "llm.provider");
    if (!provider) return "waiting";
    if (provider === "mock") return "configured";
    return providerKeyState(facts.items, provider, true) === "missing" ? "waiting" : "configured";
  }
  if (area === "costs") {
    if (facts.budgetConsumedShare !== null && facts.budgetConsumedShare >= 1) return "limit";
    const budget = itemValue(facts.items, "tokens.monthly_budget");
    return typeof budget === "number" && budget > 0 ? "configured" : null;
  }
  return null;
}

export interface AreaSentence {
  key: TranslationKey;
  values?: Record<string, string | number>;
}

export interface AreaSentenceFacts extends AreaFacts {
  canWrite: boolean;
  providerName(provider: string): string;
  modelName(provider: string, model: string): string;
  budgetText(tokens: number): string;
  spentText: string | null;
  resetDate: string;
  apiKeyName: string;
}

const CHAT_PLATFORMS: readonly { id: string; secret: string; name: string }[] = [
  { id: "slack", secret: "platform.slack.signing_secret", name: "Slack" },
  { id: "teams", secret: "platform.teams.app_password", name: "Microsoft Teams" },
  { id: "googlechat", secret: "platform.googlechat.private_key", name: "Google Chat" },
];

export function connectedChatPlatforms(items: readonly SettingItem[]) {
  return CHAT_PLATFORMS.map((platform) => {
    const secret = items.find((item) => item.path === platform.secret);
    return { ...platform, connected: secret ? settingSecretStored(secret) : false };
  });
}

export function ownObjectStore(items: readonly SettingItem[]): boolean {
  return stringValue(items, "storage.object_store.bucket").length > 0;
}

export function authMethodNames(items: readonly SettingItem[], apiKeyName: string): string[] {
  const providers = itemValue(items, "auth.providers");
  if (!Array.isArray(providers)) return [];
  const names = providers
    .map((provider) => {
      if (!provider || typeof provider !== "object") return "";
      if (provider.protocol === "api_key") return apiKeyName;
      return typeof provider.label === "string" ? provider.label : "";
    })
    .filter((label) => label.length > 0);
  return [...new Set(names)];
}

export function areaSentences(area: SettingAreaId, facts: AreaSentenceFacts): AreaSentence[] {
  const { items } = facts;
  if (area === "ai") {
    const provider = stringValue(items, "llm.provider");
    if (!provider) return [{ key: "settings.overview.ai.none" }];
    if (provider === "mock") return [{ key: "settings.overview.ai.mock" }];
    const providerName = facts.providerName(provider);
    if (providerKeyState(items, provider, true) === "missing")
      return [{ key: "settings.overview.ai.keyMissing", values: { provider: providerName } }];
    const chosenModel = stringValue(items, "llm.model");
    const model = facts.modelName(provider, chosenModel);
    const fallback = stringValue(items, "llm.fallback_provider");
    if (fallback) {
      const fallbackProvider = facts.providerName(fallback);
      return chosenModel
        ? [
            {
              key: "settings.overview.ai.withFallback",
              values: { provider: providerName, model, fallbackProvider },
            },
          ]
        : [
            {
              key: "settings.overview.ai.defaultModelWithFallback",
              values: { provider: providerName, fallbackProvider },
            },
          ];
    }
    return chosenModel
      ? [{ key: "settings.overview.ai.noFallback", values: { provider: providerName, model } }]
      : [
          {
            key: "settings.overview.ai.defaultModelNoFallback",
            values: { provider: providerName },
          },
        ];
  }
  if (area === "costs") {
    const budget = itemValue(items, "tokens.monthly_budget");
    if (typeof budget !== "number" || budget <= 0)
      return [{ key: "settings.overview.costs.noLimit" }];
    if (facts.budgetConsumedShare !== null && facts.budgetConsumedShare >= 1)
      return [{ key: "settings.overview.costs.reached", values: { date: facts.resetDate } }];
    return [
      {
        key: facts.spentText
          ? "settings.overview.costs.limit"
          : "settings.overview.costs.limitOnly",
        values: { amount: facts.budgetText(budget), spent: facts.spentText ?? "" },
      },
    ];
  }
  if (area === "access") {
    const methods = authMethodNames(items, facts.apiKeyName);
    return [
      methods.length > 0
        ? { key: "settings.overview.access.methods", values: { methods: methods.join(", ") } }
        : { key: "settings.overview.access.purpose" },
    ];
  }
  if (area === "connections") {
    const platforms = connectedChatPlatforms(items).filter((platform) => platform.connected);
    return [
      platforms.length > 0
        ? {
            key: "settings.overview.connections.chat",
            values: { platforms: platforms.map((platform) => platform.name).join(", ") },
          }
        : { key: "settings.overview.connections.noChat" },
      {
        key: ownObjectStore(items)
          ? "settings.overview.connections.ownStorage"
          : "settings.overview.connections.subkitStorage",
      },
    ];
  }
  if (area === "notifications") {
    const push = itemValue(items, "notifications.push.enabled") === true;
    const from = stringValue(items, "notifications.push.quietHoursStart");
    const to = stringValue(items, "notifications.push.quietHoursEnd");
    return [
      {
        key: push
          ? "settings.overview.notifications.push"
          : "settings.overview.notifications.cockpitOnly",
      },
      from && to
        ? { key: "settings.overview.notifications.quiet", values: { from, to } }
        : { key: "settings.overview.notifications.noQuiet" },
    ];
  }
  const restart = facts.pendingRestart.length;
  if (restart > 0)
    return [
      restart === 1
        ? { key: "settings.overview.operations.restart.one" }
        : { key: "settings.overview.operations.restart", values: { count: restart } },
    ];
  return [
    {
      key: facts.canWrite
        ? "settings.overview.operations.default"
        : "settings.overview.operations.readOnly",
    },
  ];
}

const MICROUNITS = /^[1-9]\d{0,17}$/;
const WHOLE_TOKENS = /^\d+$/;

export function settingsGuidedErrors(
  items: readonly SettingItem[],
  drafts: Readonly<Record<string, string>>,
): string[] {
  const effective = (path: string) => drafts[path] ?? stringValue(items, path);
  return Object.entries(drafts).flatMap(([path, text]) => {
    const draft = { text };
    if (path.startsWith(HOSTED_LLM_PREFIX) && path.endsWith("_microunits"))
      return MICROUNITS.test(draft.text) ? [] : [path];
    if (path === "tokens.monthly_budget") return WHOLE_TOKENS.test(draft.text.trim()) ? [] : [path];
    if (path === "llm.fallback_provider")
      return draft.text !== "" && draft.text === effective("llm.provider") ? [path] : [];
    return [];
  });
}
