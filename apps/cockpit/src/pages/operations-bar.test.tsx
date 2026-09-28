// The operations bar as a reader sees it: always four figures, each a link
// into the list of the same window — or a sentence saying why there is no
// number, never a bare 0 behind a link. And Nutzung mirrors none of it: the
// figures have one place (§0.1).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { OperationsBar } from "./operations-bar";
import { operatingFigures, windowBounds } from "./operations-figures";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const DAY = windowBounds("24h", NOW);
const answered = <T,>(value: T) => ({ state: "answered" as const, value });
const all = { runs: true, connectors: true, audit: true };

function render(figures: ReturnType<typeof operatingFigures>, locale: Locale = "de"): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
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

describe("the operations bar", () => {
  test("holds four figures, every link carrying the window it counted", () => {
    const html = render(
      operatingFigures({
        bounds: DAY,
        totals: answered({ executions: 40, failedRuns: 2, successRatePercent: 95 }),
        connectors: answered({ enabled: 8, notOk: 2 }),
        repairs: answered({ decided: 4, applied: 3 }),
        canOpen: all,
      }),
    );
    expect([...html.matchAll(/data-testid="operations-figure-[a-zA-Z]+"/g)]).toHaveLength(4);
    const links = hrefs(html);
    expect(links).toHaveLength(4);
    const from = encodeURIComponent(DAY.from);
    // Runs, failed runs and decided repairs: the window's bounds, not "all".
    for (const link of [links[0], links[1], links[3]])
      expect(link?.includes(from) || link?.includes(DAY.from)).toBe(true);
    expect(links[1]).toContain("status=failed");
    // Connector health is a state of now, marked so.
    expect(links[2]).toContain("health=not_ok");
    expect(html).toContain("Stand jetzt");
  });

  test("a figure with nothing to count says so — no 0, no link", () => {
    const html = render(
      operatingFigures({
        bounds: DAY,
        totals: answered({ executions: 0, failedRuns: 0, successRatePercent: null }),
        connectors: answered({ enabled: 0, notOk: 0 }),
        repairs: answered({ decided: 0, applied: 0 }),
        canOpen: all,
      }),
    );
    expect([...html.matchAll(/data-testid="operations-figure-[a-zA-Z]+"/g)]).toHaveLength(4);
    expect(hrefs(html)).toEqual([]);
    expect(html).not.toContain("data-family-kpi-value");
    expect(html).toContain("Keine im Zeitraum");
    expect(html).toContain("Keine aktiven Konnektoren");
  });

  test("a failed read is said per figure, with a way to read again", () => {
    const html = render(
      operatingFigures({
        bounds: DAY,
        totals: { state: "failed" },
        connectors: answered({ enabled: 3, notOk: 0 }),
        repairs: answered({ decided: 1, applied: 1 }),
        canOpen: all,
      }),
    );
    expect(html).toContain('data-testid="operations-figure-runs-retry"');
    expect(html).toContain('data-testid="operations-figure-successRate-retry"');
    expect(html).not.toContain('data-testid="operations-figure-repairRate-retry"');
    expect(html).toContain("Nicht lesbar");
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
      "repairStatsEndpoint",
      "CONNECTORS_NOT_OK_ENDPOINT",
    ])
      expect(source, `usage.tsx mirrors ${mirror}`).not.toContain(mirror);
  });
});
