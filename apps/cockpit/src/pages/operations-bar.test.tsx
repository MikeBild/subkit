import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewKpis } from "@/features/operations";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { operatingFigures, type StatsWindow, windowBounds } from "@/lib/operations-figures";
import { STATS_WINDOWS } from "@/lib/stats-window";
import { budgetSummary } from "@/lib/usage-model";
import { kpiCards, RepairRequiredHint } from "./operations-bar";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const DAY = windowBounds("24h", NOW);
const answered = <T,>(value: T) => ({ state: "answered" as const, value });
const all = { runs: true, connectors: true, audit: true, usage: true, budgetSetting: true };
const spend = answered({
  calls: 120,
  cost: { amount: 87.22, currency: "USD", unpricedModels: [], unpricedCalls: 0 },
});
const month = (
  used: number,
  cap: number | null,
  state: string | null = cap === null ? null : "ample",
) =>
  answered(
    budgetSummary({
      tokens_month: used,
      monthly_budget_tokens: cap,
      remaining_monthly_budget_tokens: cap === null ? null : Math.max(cap - used, 0),
      monthly_budget_state: state,
    }),
  );
const budget = month(40_500_000, 150_000_000);

function i18nValue(locale: Locale): I18nValue {
  return {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
}

const visuals = {
  trends: { runs: [3, 5, 4], successRate: [90, 100], cost: null, budget: [1, 2] },
  connectors: { enabled: 8, notOk: 2, needsReauth: 1 },
};

const counts = (
  over: {
    runs?: { total: number; failed: number; successRatePercent: number | null };
    connectors?: {
      enabled: number;
      notOk: number;
      needsReauth: number;
      healthyPercent: number | null;
    };
    repairs?: { decided: number; appliedPercent: number | null };
  } = {},
) =>
  answered({
    runs: { total: 40, failed: 2, successRatePercent: 95 },
    connectors: { enabled: 8, notOk: 2, needsReauth: 1, healthyPercent: 75 },
    repairs: { decided: 4, appliedPercent: 75 },
    ...over,
  });

const figuresOf = (overrides: Partial<Parameters<typeof operatingFigures>[0]> = {}) =>
  operatingFigures({
    bounds: DAY,
    counts: counts(),
    connectorsPermitted: true,
    spend,
    budget,
    canOpen: all,
    ...overrides,
  });

type Figures = ReturnType<typeof operatingFigures>;

function cardsOf(figures: Figures, locale: Locale = "de", window: StatsWindow = "24h") {
  return kpiCards(figures, visuals, i18nValue(locale).t, locale, window);
}

function card(figures: Figures, id: string, locale: Locale = "de") {
  const found = cardsOf(figures, locale).find((entry) => entry.id === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
}

function render(figures: Figures, locale: Locale = "de"): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={i18nValue(locale)}>
      <OverviewKpis cards={cardsOf(figures, locale)} onRetry={() => {}} />
    </I18nContext.Provider>,
  );
}

const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((match) => (match[1] ?? "").replaceAll("&amp;", "&"));

describe("the overview KPI cards keep every operating fact once", () => {
  test("the runs card shows the failure count below its value", () => {
    expect(card(figuresOf(), "runs")).toMatchObject({ value: "40", detail: "2 fehlgeschlagen" });
    const clean = figuresOf({
      counts: counts({ runs: { total: 40, failed: 0, successRatePercent: 100 } }),
    });
    expect(card(clean, "runs").detail).toBeNull();
  });

  test("budget pressure colours the value with the tone's ink", () => {
    expect(card(figuresOf(), "budget")).toMatchObject({
      tone: null,
      detail: "27 % des Monatskontingents",
    });
    const critical = figuresOf({ budget: month(142_500_000, 150_000_000, "critical") });
    expect(card(critical, "budget").tone).toBe("danger");
    const html = render(critical);
    expect(html).toContain("text-destructive-ink");
    expect(html).toContain('data-budget-pressure="danger"');
    const tight = figuresOf({ budget: month(120_000_000, 150_000_000, "tightening") });
    expect(card(tight, "budget").tone).toBe("warning");
    expect(render(tight)).toContain("text-warning-ink");
  });

  test("without a cap the budget card says so and links to set one", () => {
    const html = render(figuresOf({ budget: month(5_000, null) }));
    expect(hrefs(html)).toContain("/settings?leaf=tokens.monthly_budget");
    expect(html).toContain('data-testid="operations-figure-budget-set-budget"');
    expect(html).toContain("Kein Kontingent");
    expect(html).toContain("Kontingent setzen");
    const reader = figuresOf({
      budget: month(5_000, null),
      canOpen: { ...all, budgetSetting: false },
    });
    expect(card(reader, "budget").link).toBeNull();
    expect(card(reader, "budget").detail).toBe("Kein Kontingent");
  });

  test("a partly priced period is a floor and names the calls without a price", () => {
    const partial = figuresOf({
      spend: answered({
        calls: 900,
        cost: { amount: 135.8, currency: "USD", unpricedModels: ["x"], unpricedCalls: 12 },
      }),
    });
    const usage = card(partial, "budget");
    expect(usage.value.replaceAll(" ", " ")).toBe("mind. 135,80 $");
    expect(usage.detail).toBe("Aufrufe ohne Preis: 12 · 27 % des Monatskontingents");
  });

  test("calls without any price say so and lead to Nutzung, never 0,00", () => {
    const html = render(figuresOf({ spend: answered({ calls: 30, cost: null }) }));
    expect(html).toContain("Modelle ohne Preis");
    expect(hrefs(html)).toContain("/usage?window=24h");
    expect(html).not.toContain("0,00");
  });

  test("a failed read is said per card with a way to read again", () => {
    const html = render(
      figuresOf({
        counts: { state: "failed" },
        spend: { state: "failed" },
        budget: { state: "failed" },
      }),
    );
    for (const id of ["runs", "successRate", "connectorHealth", "budget"])
      expect(html).toContain(`data-testid="operations-figure-${id}-retry"`);
    expect(html).toContain("Nicht lesbar");
  });

  test("the repair hint links to the filtered workflow list only when workflows need repair", () => {
    const hint = (count: number | null) =>
      renderToStaticMarkup(
        <I18nContext.Provider value={i18nValue("de")}>
          <RepairRequiredHint count={count} />
        </I18nContext.Provider>,
      );
    expect(hint(null)).toBe("");
    expect(hint(0)).toBe("");
    expect(hrefs(hint(13))).toEqual(["/cockpit/workflows?operating_status=repair_required"]);
    expect(hint(13)).toContain("13 Workflows brauchen eine Korrektur");
    expect(hint(1)).toContain("1 Workflow braucht eine Korrektur");
  });

  test("every window names itself in the card label, connector health stays current", () => {
    for (const window of STATS_WINDOWS) {
      const cards = cardsOf(figuresOf({ bounds: windowBounds(window, NOW) }), "de", window);
      const label = translate("de", `overview.operations.windowOption.${window}`);
      expect(cards.find((entry) => entry.id === "runs")?.label).toBe(`Runs · ${label}`);
      expect(cards.find((entry) => entry.id === "connectorHealth")?.label).toBe(
        "Gesunde Connectors · Stand jetzt",
      );
    }
  });
});

describe("Nutzung", () => {
  test("carries no operations block — the figures live on the Übersicht only", () => {
    const source = readFileSync(
      new URL("../features/usage/breakdown.tsx", import.meta.url),
      "utf8",
    );
    for (const mirror of [
      "operatingFigures",
      "OperationsBar",
      "usage-figure",
      "usage-summary",
      "operatingCounts",
    ])
      expect(source, `the usage breakdown mirrors ${mirror}`).not.toContain(mirror);
  });

  test("reads the window its address names, so the cost figure's link lands on its window", () => {
    const page = readFileSync(new URL("../features/usage/usage-page.tsx", import.meta.url), "utf8");
    const breakdown = readFileSync(
      new URL("../features/usage/breakdown.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain("windowBounds(usageWindowFromUrl(search))");
    expect(breakdown).toContain(`useLlmQuery(allowed, bounds, "flow")`);
  });
});

describe("the overview's KPI cards", () => {
  test("each card names its period, its value and draws its trend", () => {
    const runs = card(figuresOf(), "runs");
    expect(runs).toMatchObject({ label: "Runs · 24 Std", value: "40", trend: [3, 5, 4] });
    expect(runs.href).toContain("runs=all");
  });

  test("connector health draws dots instead of a line and no sign-in sentence", () => {
    expect(card(figuresOf(), "connectorHealth")).toMatchObject({
      value: "75 %",
      trend: null,
      dots: visuals.connectors,
      detail: null,
    });
  });

  test("a figure that could not be read shows a dash and why", () => {
    expect(card(figuresOf({ counts: { state: "failed" } }), "runs")).toMatchObject({
      value: "—",
      note: "Nicht lesbar",
      trend: null,
      retry: true,
    });
  });
});
