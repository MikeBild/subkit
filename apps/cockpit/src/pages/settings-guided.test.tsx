import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { rememberHostedModels } from "@/pages/settings";
import { fallbackChange } from "@/pages/settings-ai";
import {
  CostsArea,
  type HostedModelEntry,
  hostedAllowlistDraft,
  hostedDraftText,
  hostedFieldText,
  hostedModelChips,
} from "@/pages/settings-costs";
import { type GuidedContext, GuidedRows } from "@/pages/settings-guided";
import type { SettingItem } from "@/pages/settings-model";

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

const hosted = (model: string): HostedModelEntry => ({
  model,
  max_context_tokens: 200000,
  max_output_tokens: 8000,
  input_usd_per_million_tokens: "1",
  output_usd_per_million_tokens: "5",
  cache_read_usd_per_million_tokens: "0.1",
  cache_write_5m_usd_per_million_tokens: "1.25",
  cache_write_1h_usd_per_million_tokens: "2",
});

const items: SettingItem[] = [
  leaf("llm.provider", "openai", { kind: "enum", enum_values: ["mock", "openai", "anthropic"] }),
  leaf("llm.hosted.enabled", true, { kind: "boolean", scope: "global" }),
  leaf("llm.hosted.tenant_monthly_microunits", "5000000", { kind: "string", scope: "global" }),
  leaf("llm.hosted.global_monthly_microunits", "50000000", { kind: "string", scope: "global" }),
  leaf("llm.hosted.models", [hosted("openai:gpt-4.1-mini")], { kind: "json", scope: "global" }),
  leaf("tokens.monthly_budget", 0, { kind: "number", default: 0 }),
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
    usage: null,
    publicBaseUrl: "https://subkit.test",
    rememberedHostedModels: [],
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

describe("hosted budgets", () => {
  test("show the saved amount once no draft is open, even after typing", () => {
    expect(hostedFieldText("5000000", undefined, "9")).toBe("5");
    expect(hostedFieldText("5000000", "7000000", null)).toBe("7");
    expect(hostedFieldText("5000000", "7000000", "7,0")).toBe("7,0");
  });

  test("0 stays as typed and is not turned into a valid amount", () => {
    expect(hostedDraftText("0")).toBe("0");
    expect(hostedDraftText("12,5")).toBe("12500000");
  });

  test("are marked as applying to all workspaces in workspace mode", () => {
    const html = render(<CostsArea ctx={ctx({ scope: "tenant" })} />);
    expect(html).toContain(
      'data-testid="settings-global-only-llm.hosted.tenant_monthly_microunits"',
    );
    expect(html).toContain('data-testid="settings-global-only-llm.hosted.models"');
    expect(render(<CostsArea ctx={ctx()} />)).not.toContain("settings-global-only-");
  });
});

describe("the hosted allowlist", () => {
  test("an unticked model keeps its limits and can be ticked again after saving", () => {
    const mini = hosted("openai:gpt-4.1-mini");
    const sonnet = hosted("anthropic:claude-sonnet-5");
    let remembered = rememberHostedModels([], [mini, sonnet]);
    const before = hostedModelChips([mini, sonnet], [mini], remembered as HostedModelEntry[]);
    expect(before.entries.map((entry) => entry.model)).toEqual([mini.model, sonnet.model]);
    expect([...before.allowed]).toEqual([mini.model]);
    const saved = JSON.parse(hostedAllowlistDraft(before.entries, before.allowed));
    expect(saved).toEqual([mini]);
    remembered = rememberHostedModels(remembered, saved);
    const after = hostedModelChips(saved, null, remembered as HostedModelEntry[]);
    expect(after.entries.map((entry) => entry.model)).toEqual([mini.model, sonnet.model]);
    expect([...after.allowed]).toEqual([mini.model]);
    expect(
      JSON.parse(hostedAllowlistDraft(after.entries, new Set([mini.model, sonnet.model]))),
    ).toEqual([mini, sonnet]);
  });

  test("says that saving removes unticked models", () => {
    const html = render(<CostsArea ctx={ctx({ drafts: { "llm.hosted.models": "[]" } })} />);
    expect(html).toContain('data-testid="settings-costs-allowed-removed"');
  });
});

describe("the price list in another currency", () => {
  test("keeps built-in prices in dollars and asks for own prices", () => {
    const html = render(<CostsArea ctx={ctx({ drafts: { "tokens.currency": "EUR" } })} />).replace(
      /\u00a0/g,
      " ",
    );
    expect(html.includes("0,40 $")).toBe(true);
    expect(html.includes("0,40 €")).toBe(false);
    expect(html).toContain('data-testid="settings-costs-own-prices-needed"');
    expect(render(<CostsArea ctx={ctx()} />)).not.toContain("settings-costs-own-prices-needed");
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
    leaf("tokens.monthly_budget", 0, { kind: "number", default: 0 }),
  ];
  const workspace = [
    own("llm.provider", "anthropic", {
      kind: "enum",
      enum_values: ["mock", "openai", "anthropic"],
    }),
    own("llm.model", "claude-sonnet-4-6", { kind: "string", default: "" }),
    leaf("tokens.monthly_budget", 0, { kind: "number", default: 0 }),
  ];
  const base = (overrides: Partial<GuidedContext>) =>
    ctx({ items: global, globalItems: global, tenantItems: workspace, ...overrides });

  test("in the all-workspaces mode each field says the workspace keeps its own value", async () => {
    const { AiArea } = await import("@/pages/settings-ai");
    const html = render(<AiArea ctx={base({ effectiveItems: workspace })} />);
    expect(html).toContain(
      "Dieser Arbeitsbereich nutzt einen eigenen Wert: Anthropic. Die Änderung hier gilt für ihn nicht.",
    );
    expect(html).toContain('data-testid="settings-own-value-here-llm.provider"');
  });

  test("an empty general value reads as the provider's default model, never as (leer)", async () => {
    const { AiArea } = await import("@/pages/settings-ai");
    const html = render(
      <AiArea ctx={base({ items: workspace, scope: "tenant", effectiveItems: workspace })} />,
    );
    expect(html).toContain("Der allgemeine Wert (Standardmodell des Anbieters) gilt hier nicht.");
    expect(html).not.toContain("(leer)");
  });

  test("the costs page names the workspace's provider, and says test mode costs nothing", () => {
    const anthropic = render(<CostsArea ctx={base({ effectiveItems: workspace })} />);
    expect(anthropic).toContain("Prüf die Rechnung bei Anthropic dann regelmäßig selbst.");
    expect(anthropic).not.toContain("bei Testmodus");
    const mock = render(<CostsArea ctx={base({ effectiveItems: global })} />);
    expect(mock).toContain("Im Testmodus entstehen keine Kosten.");
    expect(mock).not.toContain("Testmodus ohne echte KI dann");
    expect(mock).not.toContain("kommt von Testmodus");
  });

  test("the budget for all workspaces is a limit for each workspace, not a shared pot", () => {
    const html = render(<CostsArea ctx={base({ effectiveItems: workspace })} />);
    expect(html).toContain("Für alle Arbeitsbereiche (jeder einzeln)");
    expect(html).toContain(
      "Jeder Arbeitsbereich darf so viel verbrauchen, außer er hat ein eigenes Limit.",
    );
    expect(html).not.toContain("teilen sich");
  });
});

describe("the usage bar", () => {
  test("measures against the drafted limit, like the sentence below it", async () => {
    const { budgetBarShare } = await import("@/pages/settings-costs");
    expect(budgetBarShare(265103, 10000000)).toBeCloseTo(0.0265103);
    expect(budgetBarShare(265103, 0)).toBeNull();
    expect(budgetBarShare(null, 100)).toBeNull();
    const html = render(
      <CostsArea
        ctx={ctx({
          drafts: { "tokens.monthly_budget": "10000000" },
          usage: {
            state: "ample",
            usedTokens: 265103,
            budgetTokens: 442268,
            remainingTokens: 177165,
            consumedShare: 265103 / 442268,
          },
        })}
      />,
    );
    expect(html).toContain('data-share="0.0265"');
    expect(html).toContain("Diesen Monat: ca. 265.103 Textbausteine von 10.000.000 Textbausteine");
  });
});
