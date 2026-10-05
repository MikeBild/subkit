import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { OperationsBar } from "./operations-bar";
import { operatingFigures, windowBounds } from "./operations-figures";
import { budgetSummary } from "./usage-model";

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
const monthSpend = answered({
  calls: 900,
  cost: { amount: 135.8, currency: "USD", unpricedModels: [], unpricedCalls: 0 },
});

function render(figures: ReturnType<typeof operatingFigures>, locale: Locale = "de"): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <OperationsBar figures={figures} pending={false} onRetry={() => {}} />
    </I18nContext.Provider>,
  );
}

const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((match) => (match[1] ?? "").replaceAll("&amp;", "&"));

function figureText(html: string, id: string): string {
  const start = html.indexOf(`data-testid="operations-figure-${id}"`);
  const open = html.lastIndexOf("<div", start);
  const next = html.indexOf("data-figure-state=", html.indexOf("data-figure-state=", start) + 1);
  const slice = html.slice(open, next === -1 ? undefined : html.lastIndexOf("<div", next));
  return slice
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll(" ", " ")
    .replace(/\s+/g, " ")
    .trim();
}

const counts = (
  over: {
    runs?: { total: number; failed: number; successRatePercent: number | null };
    connectors?: { enabled: number; notOk: number; healthyPercent: number | null };
    repairs?: { decided: number; appliedPercent: number | null };
  } = {},
) =>
  answered({
    runs: { total: 40, failed: 2, successRatePercent: 95 },
    connectors: { enabled: 8, notOk: 2, healthyPercent: 75 },
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
    monthSpend,
    canOpen: all,
    ...overrides,
  });

describe("the operations bar", () => {
  test("holds six figures, every link carrying the window it counted", () => {
    const html = render(figuresOf());
    expect([...html.matchAll(/data-testid="operations-figure-[a-zA-Z]+"/g)]).toHaveLength(6);
    const links = hrefs(html);
    expect(links).toHaveLength(6);
    const from = encodeURIComponent(DAY.from);
    for (const link of [links[0], links[1], links[3]])
      expect(link?.includes(from) || link?.includes(DAY.from)).toBe(true);
    expect(links[1]).toContain("status=failed");
    expect(links[2]).toContain("health=not_ok");
    expect(html).toContain("Stand jetzt");
    expect(links[4]).toBe("/cockpit/usage?window=24h");
    expect(links[5]).toBe("/cockpit/usage");
  });

  test("the cost figure shows the window's spend in its currency", () => {
    const html = render(figuresOf());
    expect(figureText(html, "cost")).toBe("Kosten87,22 $");
    expect(html.replaceAll(" ", " ")).toContain('data-family-kpi-value="87,22 $"');
    expect(html).not.toContain("mind.");
  });

  test("a partly priced window reads 'mind.' and names what it leaves out", () => {
    const html = render(
      figuresOf({
        spend: answered({
          calls: 120,
          cost: {
            amount: 412.87,
            currency: "EUR",
            unpricedModels: ["some-new-model"],
            unpricedCalls: 47,
          },
        }),
      }),
    );
    expect(figureText(html, "cost")).toBe("Kostenmind. 412,87 €Aufrufe ohne Preis: 47");
  });

  test("calls without any price say so and lead to Nutzung, never '0,00 $'", () => {
    const html = render(figuresOf({ spend: answered({ calls: 30, cost: null }) }));
    expect(figureText(html, "cost")).toBe("KostenModelle ohne PreisNutzung");
    expect(html).toContain('data-figure-state="unpriced"');
    expect(hrefs(html)).toContain("/cockpit/usage?window=24h");
    expect(html).not.toContain("0,00");
  });

  test("the month's usage leads with its money, then its share of the cap, what is left and its state", () => {
    const html = render(figuresOf());
    expect(figureText(html, "budget")).toBe(
      "Nutzung · Monat135,80 $27 % von 150 Mio. TokenReichlich · 109,5 Mio. übrig",
    );
    expect(html).toContain('data-budget-pressure="ample"');
    expect(hrefs(html)).toContain("/cockpit/usage");
    const critical = render(figuresOf({ budget: month(142_500_000, 150_000_000, "critical") }));
    expect(figureText(critical, "budget")).toContain("95 %");
    expect(figureText(critical, "budget")).toContain("Fast aufgebraucht");
    expect(critical).toContain('data-budget-pressure="critical"');
    expect(critical).toContain("text-destructive");
    expect(figureText(render(figuresOf(), "en"), "budget")).toBe(
      "Usage · Month$135.8027 % of 150M tokensComfortable · 109.5M left",
    );
  });

  test("a partly priced month is a floor; an unpriced one falls back to its share", () => {
    const partial = render(
      figuresOf({
        monthSpend: answered({
          calls: 900,
          cost: { amount: 135.8, currency: "USD", unpricedModels: ["x"], unpricedCalls: 12 },
        }),
      }),
    );
    expect(figureText(partial, "budget")).toContain("mind. 135,80 $");
    const unpriced = render(figuresOf({ monthSpend: answered({ calls: 30, cost: null }) }));
    expect(figureText(unpriced, "budget")).toBe(
      "Nutzung · Monat27 %von 150 Mio. TokenReichlich · 109,5 Mio. übrig",
    );
  });

  test("no cap still shows the month's money and says 'Kein Kontingent'", () => {
    const html = render(figuresOf({ budget: month(5_000, null) }));
    expect(figureText(html, "budget")).toBe("Nutzung · Monat135,80 $Kein Kontingent");
    expect(hrefs(html)).toContain("/cockpit/usage");
  });

  test("no cap and no amount reads 'Kein Kontingent' — no percentage — with the setting for an admin", () => {
    const unpriced = answered({ calls: 30, cost: null });
    const html = render(figuresOf({ budget: month(5_000, null), monthSpend: unpriced }));
    expect(figureText(html, "budget")).toBe("Nutzung · MonatKein KontingentKontingent setzen");
    expect(html).toContain('data-figure-state="uncapped"');
    expect(hrefs(html)).toContain("/cockpit/settings?leaf=tokens.monthly_budget");
    const reader = render(
      figuresOf({
        budget: month(5_000, null),
        monthSpend: unpriced,
        canOpen: { ...all, budgetSetting: false },
      }),
    );
    expect(figureText(reader, "budget")).toBe("Nutzung · MonatKein Kontingent");
  });

  test("a figure with nothing to count says so — no 0, no link", () => {
    const html = render(
      figuresOf({
        counts: counts({
          runs: { total: 0, failed: 0, successRatePercent: null },
          connectors: { enabled: 0, notOk: 0, healthyPercent: null },
          repairs: { decided: 0, appliedPercent: null },
        }),
        spend: answered({ calls: 0, cost: null }),
        budget: month(0, null),
        monthSpend: answered({ calls: 0, cost: null }),
        canOpen: { ...all, budgetSetting: false },
      }),
    );
    expect([...html.matchAll(/data-testid="operations-figure-[a-zA-Z]+"/g)]).toHaveLength(6);
    expect(hrefs(html)).toEqual([]);
    expect(html).not.toContain("data-family-kpi-value");
    expect(html).toContain("Keine im Zeitraum");
    expect(html).toContain("Keine aktiven Konnektoren");
    expect(html).toContain("Keine Modellaufrufe im Zeitraum");
  });

  test("a failed read is said per figure, with a way to read again", () => {
    const html = render(
      figuresOf({
        counts: { state: "failed" },
        spend: { state: "failed" },
        budget: { state: "failed" },
      }),
    );
    for (const id of ["runs", "successRate", "connectorHealth", "repairRate", "cost", "budget"])
      expect(html).toContain(`data-testid="operations-figure-${id}-retry"`);
    expect(html).toContain("Nicht lesbar");
    const partial = render(figuresOf({ spend: { state: "failed" } }));
    expect(partial).toContain('data-testid="operations-figure-cost-retry"');
    expect(partial).not.toContain('data-testid="operations-figure-repairRate-retry"');
  });
});

describe("Nutzung", () => {
  test("carries no operations block — the figures live on the Übersicht only", () => {
    const source = readFileSync(new URL("./usage.tsx", import.meta.url), "utf8");
    for (const mirror of [
      "operatingFigures",
      "OperationsBar",
      "usage-figure",
      "usage-summary",
      "operatingFiguresEndpoint",
      "operatingCounts",
    ])
      expect(source, `usage.tsx mirrors ${mirror}`).not.toContain(mirror);
  });

  test("reads the window its address names, so the cost figure's link lands on its window", () => {
    const source = readFileSync(new URL("./usage.tsx", import.meta.url), "utf8");
    expect(source).toContain("usageWindowFromUrl(window.location.search)");
    expect(source).toContain(`llmStatsEndpoint(bounds, "workflow")`);
  });
});
