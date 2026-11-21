import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PromptCacheFlow } from "@/features/usage/model/operations-figures";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { type PromptCacheRead, PromptCacheSection, PromptCacheTile } from "./prompt-cache";

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

const FLOWS: PromptCacheFlow[] = [
  { flow: "converse", calls: 940, promptTokens: 76_000, cacheReadTokens: 59_000, percent: 78 },
  { flow: "generate", calls: 180, promptTokens: 4_000, cacheReadTokens: 0, percent: 0 },
  { flow: "critic_custom", calls: 4, promptTokens: 1_000, cacheReadTokens: 500, percent: 50 },
  { flow: "workflow_step", calls: 3, promptTokens: 0, cacheReadTokens: 0, percent: null },
];

const answered = (value: PromptCacheFlow[] | null): PromptCacheRead => ({
  state: "answered",
  value,
});

function render(node: React.ReactNode, locale: Locale = "de"): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={i18nValue(locale)}>{node}</I18nContext.Provider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&quot;", '"')
    .replace(/[ \t\n]+/g, " ")
    .trim();

function rows(html: string): string[] {
  return [...html.matchAll(/<li[^>]*data-testid="usage-prompt-cache-flow"[^>]*>([\s\S]*?)<\/li>/g)]
    .map((match) => text(match[1] ?? ""))
    .filter(Boolean);
}

function barLabels(html: string): string[] {
  return [...html.matchAll(/role="img" aria-label="([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("the prompt-cache tile", () => {
  test("shows the overall share weighted by prompt tokens with the approved sub-line", () => {
    const html = render(
      <PromptCacheTile read={answered(FLOWS)} period="Diese Woche" onRetry={() => {}} />,
    );
    expect(text(html)).toBe(
      "Aus dem Zwischenspeicher · Diese Woche 73 % der Eingabe wurde wiederverwendet statt neu bezahlt",
    );
    expect(html).toContain('data-figure-state="value"');
  });

  test("says no data in words instead of a bare zero when no flow reported prompt tokens", () => {
    const html = render(
      <PromptCacheTile
        read={answered([FLOWS[3] as PromptCacheFlow])}
        period="Diese Woche"
        onRetry={() => {}}
      />,
    );
    expect(text(html)).toBe("Aus dem Zwischenspeicher · Diese Woche Ohne Daten");
    expect(html).not.toContain("0 %");
  });

  test("an unreadable answer offers to read again", () => {
    for (const read of [answered(null), { state: "failed" } as const]) {
      const html = render(<PromptCacheTile read={read} period="Diese Woche" onRetry={() => {}} />);
      expect(html).toContain('data-figure-state="unreadable"');
      expect(html).toContain('data-testid="usage-kpi-prompt-cache-retry"');
    }
  });
});

describe("the prompt cache per flow", () => {
  test("lists each flow with its label, hint and right-aligned share, no data in words", () => {
    const html = render(<PromptCacheSection read={answered(FLOWS)} onRetry={() => {}} />);
    expect(text(html)).toStartWith("Zwischenspeicher je Ablauf Höher ist günstiger und schneller");
    expect(rows(html)).toEqual([
      "Chat Antworten im Chat 78 %",
      "Workflows bauen Baut Entwürfe aus einer Beschreibung 0 %",
      "critic_custom 50 %",
      "Workflow-Schritte KI-Schritte in laufenden Workflows Ohne Daten",
    ]);
    expect(html).toContain('data-testid="usage-prompt-cache-footnote"');
    expect(text(html)).toContain("„Ohne Daten“ heißt:");
  });

  test("every bar is an image with a spoken share, filled in the one accent", () => {
    const html = render(<PromptCacheSection read={answered(FLOWS)} onRetry={() => {}} />);
    expect(barLabels(html)).toEqual([
      "Chat: 78 % aus dem Zwischenspeicher",
      "Workflows bauen: 0 % aus dem Zwischenspeicher",
      "critic_custom: 50 % aus dem Zwischenspeicher",
      "Workflow-Schritte: ohne Daten",
    ]);
    expect(html).toContain('style="width:78%"');
    expect([...html.matchAll(/bg-chart-1/g)]).toHaveLength(3);
  });

  test("the footnote stays away while every flow has provider data", () => {
    const html = render(
      <PromptCacheSection read={answered(FLOWS.slice(0, 2))} onRetry={() => {}} />,
    );
    expect(html).not.toContain('data-testid="usage-prompt-cache-footnote"');
  });

  test("speaks English when the reader does", () => {
    const html = render(<PromptCacheSection read={answered(FLOWS)} onRetry={() => {}} />, "en");
    expect(text(html)).toStartWith("Cache per flow Higher is cheaper and faster");
    expect(barLabels(html)[0]).toBe("Chat: 78% from the cache");
    expect(rows(html)[3]).toBe("Workflow steps AI steps inside running workflows No data");
  });

  test("an empty window and an unreadable answer are told apart", () => {
    expect(render(<PromptCacheSection read={answered([])} onRetry={() => {}} />)).toContain(
      'data-testid="usage-prompt-cache-none"',
    );
    expect(render(<PromptCacheSection read={{ state: "failed" }} onRetry={() => {}} />)).toContain(
      'data-testid="usage-prompt-cache-retry"',
    );
  });
});

describe("while the operating figures are still loading", () => {
  const loading = answered(null);

  test("the section waits instead of calling the figures unreadable", () => {
    const html = render(<PromptCacheSection read={loading} pending onRetry={() => {}} />);
    expect(html).not.toContain('data-testid="usage-prompt-cache-unreadable"');
    expect(html).not.toContain('data-testid="usage-prompt-cache-retry"');
    expect(html).not.toContain('data-testid="usage-prompt-cache-footnote"');
  });

  test("the tile waits instead of calling the figures unreadable", () => {
    const html = render(
      <PromptCacheTile read={loading} pending period="Diese Woche" onRetry={() => {}} />,
    );
    expect(html).not.toContain('data-figure-state="unreadable"');
    expect(html).not.toContain('data-testid="usage-kpi-prompt-cache-retry"');
  });
});
