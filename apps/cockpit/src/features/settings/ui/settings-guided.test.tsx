import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { recommendedModel } from "@/features/settings/model/settings-catalog";
import type { SettingItem } from "@/features/settings/model/settings-model";
import { AiArea, fallbackChange, providerSwitchChanges, summarizeChange } from "./settings-ai";
import { type GuidedContext, GuidedRows } from "./settings-guided";

function leaf(
  path: string,
  value: unknown,
  meta: Partial<SettingItem["meta"]> & { kind: string },
): SettingItem {
  return {
    path,
    value,
    meta: { source: "default", scope: "tenant", sensitive: false, requiresRestart: false, ...meta },
  };
}

const items: SettingItem[] = [
  leaf("llm.provider", "openai", { kind: "enum", enum_values: ["mock", "openai", "anthropic"] }),
  leaf("connectors.mcp.tools_list_max_pages", 0, { kind: "number", default: 0 }),
  leaf("tokens.currency", "USD", { kind: "string", default: "USD" }),
  leaf("tokens.prices", [], { kind: "json", default: [] }),
  leaf("notifications.push.thresholdSec", 60, { kind: "number", default: 30 }),
];

const catalog = {
  currency: "USD",
  models: [
    {
      provider: "openai" as const,
      model: "gpt-4.1-mini",
      display_name: "GPT-4.1 mini",
      input_per_mtok: 0.4,
      output_per_mtok: 1.6,
      price_source: "catalog" as const,
      badges: { recommended: true, economical: true, capable: false },
    },
  ],
};

function ctx(overrides: Partial<GuidedContext> = {}): GuidedContext {
  return {
    items,
    globalItems: items,
    tenantItems: items,
    effectiveItems: items,
    drafts: {},
    canWrite: true,
    pending: false,
    scope: "global",
    scopeAvailable: true,
    catalog,
    publicBaseUrl: "https://subkit.test",
    setDraft() {},
    dropDraft() {},
    onScope() {},
    navigate() {},
    ...overrides,
  };
}

describe("the replacement provider", () => {
  test("switching or turning it off clears the replacement model", () => {
    expect(fallbackChange("anthropic", "gemini")).toEqual([
      ["llm.fallback_provider", "gemini"],
      ["llm.fallback_model", ""],
    ]);
    expect(fallbackChange("anthropic", "")).toEqual([
      ["llm.fallback_provider", ""],
      ["llm.fallback_model", ""],
    ]);
    expect(fallbackChange("anthropic", "anthropic")).toEqual([]);
  });
});

describe("summaries and suggestions", () => {
  const llm = (values: Record<string, unknown> = {}) => [
    leaf("llm.provider", values.provider ?? "openai", {
      kind: "enum",
      enum_values: ["mock", "openai", "anthropic"],
    }),
    leaf("llm.model", values.model ?? "", { kind: "string", default: "" }),
    leaf("llm.fallback_provider", values.fallback_provider ?? null, {
      kind: "enum",
      default: null,
      enum_values: ["mock", "openai", "anthropic"],
    }),
    leaf("llm.fallback_model", values.fallback_model ?? "", { kind: "string", default: "" }),
    leaf("llm.summarize_provider", values.summarize_provider ?? null, {
      kind: "enum",
      default: null,
      enum_values: ["mock", "openai", "anthropic"],
    }),
    leaf("llm.summarize_model", values.summarize_model ?? "", { kind: "string", default: "" }),
    leaf("llm.suggestion_model", values.suggestion_model ?? "", { kind: "string", default: "" }),
  ];
  const area = (list: SettingItem[], overrides: Partial<GuidedContext> = {}) =>
    render(
      <AiArea
        ctx={ctx({
          items: list,
          globalItems: list,
          tenantItems: null,
          effectiveItems: list,
          ...overrides,
        })}
      />,
    );

  test("the provider default names the recommended model of that provider", () => {
    expect(recommendedModel(catalog, "openai")?.display_name).toBe("GPT-4.1 mini");
    expect(recommendedModel(catalog, "anthropic")).toBeNull();
    expect(recommendedModel(catalog, "azure")).toBeNull();
    const html = area(llm({ model: "my-own-model" }));
    expect(html).toMatch(
      /data-testid="settings-ai-model-select-list"[^>]*>Standard – GPT-4\.1 mini</,
    );
  });

  test("without a known recommendation the default keeps the provider wording", () => {
    const unrated = {
      currency: "USD",
      models: [
        {
          ...catalog.models[0]!,
          provider: "anthropic" as const,
          model: "claude-haiku-4-5",
          display_name: "Claude Haiku 4.5",
          badges: { recommended: false, economical: true, capable: false },
        },
      ],
    };
    const html = area(llm({ provider: "anthropic", model: "my-own-model" }), { catalog: unrated });
    expect(html).toMatch(
      /data-testid="settings-ai-model-select-list"[^>]*>Standardmodell von Anthropic</,
    );
  });

  test("a catalog without prices still offers the models as a list", () => {
    const unpriced = {
      currency: "EUR",
      models: [
        {
          ...catalog.models[0]!,
          input_per_mtok: null,
          output_per_mtok: null,
        },
      ],
    };
    const html = area(llm({ model: "gpt-4.1-mini" }), { catalog: unpriced });
    expect(html).toContain('data-testid="settings-ai-model-select"');
    expect(html).not.toContain('data-testid="settings-ai-model-select-custom"');
    expect(html).toContain("Preis nicht hinterlegt");
    expect(html).not.toContain("NaN");
  });

  test("are asked only when the engine offers the settings", () => {
    const html = area(llm());
    expect(html).toContain("Welche KI fasst lange Gespräche zusammen?");
    expect(html).toContain('data-testid="settings-ai-summarize-provider"');
    expect(html).toContain('data-testid="settings-ai-summarize-model"');
    expect(html).toContain("Welches Modell schlägt die nächsten Fragen vor?");
    expect(html).toContain('data-testid="settings-ai-suggestion-model"');
    const bare = area(llm().filter((item) => !/summarize|suggestion/.test(item.path)));
    expect(bare).not.toContain("settings-ai-summarize");
    expect(bare).not.toContain("settings-ai-suggestion");
  });

  test("a separate summary provider asks for its key too", () => {
    const html = area(llm({ summarize_provider: "anthropic" }));
    expect(html).toContain('data-testid="settings-ai-key-anthropic-elsewhere"');
  });

  test("switching the summary provider clears its model", () => {
    expect(summarizeChange("", "anthropic")).toEqual([
      ["llm.summarize_provider", "anthropic"],
      ["llm.summarize_model", ""],
    ]);
    expect(summarizeChange("anthropic", "")).toEqual([
      ["llm.summarize_provider", ""],
      ["llm.summarize_model", ""],
    ]);
    expect(summarizeChange("openai", "openai")).toEqual([]);
  });

  test("switching the main provider clears models of the old provider that follow it", () => {
    const list = llm({
      model: "gpt-4.1-mini",
      fallback_model: "gpt-4.1-mini",
      summarize_model: "gpt-4.1-mini",
      suggestion_model: "gpt-4.1-mini",
    });
    const base = ctx({ items: list, globalItems: list, effectiveItems: list });
    expect(providerSwitchChanges(base, "anthropic")).toEqual([
      ["llm.provider", "anthropic"],
      ["llm.model", ""],
      ["llm.suggestion_model", ""],
      ["llm.fallback_model", ""],
      ["llm.summarize_model", ""],
    ]);
    const own = ctx({
      items: list,
      globalItems: list,
      effectiveItems: list,
      drafts: {
        "llm.fallback_provider": "openai",
        "llm.summarize_provider": "openai",
        "llm.suggestion_model": "custom-small",
      },
    });
    expect(providerSwitchChanges(own, "anthropic")).toEqual([
      ["llm.provider", "anthropic"],
      ["llm.model", ""],
    ]);
    expect(providerSwitchChanges(base, "openai")).toEqual([]);
  });
});

describe("resetting in workspace mode", () => {
  test("offers no reset for a workspace value, because the engine cannot remove an override", () => {
    const paths = ["notifications.push.thresholdSec"];
    expect(render(<GuidedRows ctx={ctx()} paths={paths} />)).toContain(
      'data-testid="setting-reset-',
    );
    expect(render(<GuidedRows ctx={ctx({ scope: "tenant" })} paths={paths} />)).not.toContain(
      'data-testid="setting-reset-',
    );
  });
});

describe("what applies to the signed-in workspace", () => {
  const own = (
    path: string,
    value: unknown,
    meta: Partial<SettingItem["meta"]> & { kind: string },
  ) => leaf(path, value, { ...meta, source: "tenant" });
  const global = [
    leaf("llm.provider", "mock", { kind: "enum", enum_values: ["mock", "openai", "anthropic"] }),
    leaf("llm.model", "", { kind: "string", default: "" }),
    leaf("connectors.mcp.tools_list_max_pages", 0, { kind: "number", default: 0 }),
  ];
  const workspace = [
    own("llm.provider", "anthropic", {
      kind: "enum",
      enum_values: ["mock", "openai", "anthropic"],
    }),
    own("llm.model", "claude-sonnet-4-6", { kind: "string", default: "" }),
    leaf("connectors.mcp.tools_list_max_pages", 0, { kind: "number", default: 0 }),
  ];
  const base = (overrides: Partial<GuidedContext>) =>
    ctx({ items: global, globalItems: global, tenantItems: workspace, ...overrides });

  test("in the all-workspaces mode each field says the workspace keeps its own value", async () => {
    const { AiArea } = await import("./settings-ai");
    const html = render(<AiArea ctx={base({ effectiveItems: workspace })} />);
    expect(html).toContain(
      "Dieser Arbeitsbereich nutzt einen eigenen Wert: Anthropic. Die Änderung hier gilt für ihn nicht.",
    );
    expect(html).toContain('data-testid="settings-own-value-here-llm.provider"');
  });

  test("an empty general value reads as the provider's default model, never as (leer)", async () => {
    const { AiArea } = await import("./settings-ai");
    const html = render(
      <AiArea ctx={base({ items: workspace, scope: "tenant", effectiveItems: workspace })} />,
    );
    expect(html).toContain("Der allgemeine Wert (Standardmodell des Anbieters) gilt hier nicht.");
    expect(html).not.toContain("(leer)");
  });
});
