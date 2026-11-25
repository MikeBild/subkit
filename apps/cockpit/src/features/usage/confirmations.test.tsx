import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConfirmationSummary } from "@/features/usage/model/operations-figures";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { ConfirmationsSection, confirmationLineParts } from "./confirmations";

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

function render(node: React.ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <I18nContext.Provider value={i18nValue(locale)}>{node}</I18nContext.Provider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\n]+/g, " ")
    .trim();

const SUMMARY: ConfirmationSummary = {
  asked: 7,
  covered: 3,
  turns: 20,
  perTurn: 0.35,
  runs: 4,
  medianPerRun: 0.5,
  tools: [
    { tool: "send_email", asked: 5, covered: 2 },
    { tool: "run_workflow", asked: 2, covered: 1 },
  ],
};

const answered = (value: ConfirmationSummary) => ({ state: "answered" as const, value });

describe("the confirmations section", () => {
  test("one line with the rate per turn, the median per task run and the covered calls", () => {
    const html = render(<ConfirmationsSection read={answered(SUMMARY)} onRetry={() => {}} />, "en");
    expect(text(html)).toContain("0.35 per turn · median 0.5 per task run · 3 ran without asking");
    expect(text(html)).toContain("send_email asked 5 · without asking 2");
  });

  test("German formats the decimals and labels in its own words", () => {
    const html = render(<ConfirmationsSection read={answered(SUMMARY)} onRetry={() => {}} />, "de");
    expect(text(html)).toContain(
      [
        translate("de", "usage.confirm.perTurn", { value: "0,35" }),
        translate("de", "usage.confirm.perRun", { value: "0,5" }),
        translate("de", "usage.confirm.covered", { count: "3" }),
      ].join(" · "),
    );
  });

  test("without turns or runs the rate is left out instead of shown as zero", () => {
    expect(
      confirmationLineParts({ ...SUMMARY, turns: 0, runs: 0, perTurn: 0, medianPerRun: 0 }),
    ).toEqual({ perTurn: null, medianPerRun: null, covered: 3 });
  });

  test("nothing asked and nothing covered says so; an unreadable answer offers a retry", () => {
    const empty = { ...SUMMARY, asked: 0, covered: 0, tools: [] };
    expect(
      render(<ConfirmationsSection read={answered(empty)} onRetry={() => {}} />, "en"),
    ).toContain("Nobody was asked to confirm in this window.");
    expect(
      render(<ConfirmationsSection read={{ state: "failed" }} onRetry={() => {}} />, "en"),
    ).toContain('data-testid="usage-confirmations-retry"');
  });
});
