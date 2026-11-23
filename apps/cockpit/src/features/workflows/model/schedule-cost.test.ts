import { describe, expect, test } from "bun:test";
import { formatMoney, type Locale, translate, translatePlural } from "@/lib/i18n";
import { type ScheduleCostProjection, scheduleCostWords } from "./schedule-cost";

const estimated: ScheduleCostProjection = {
  state: "estimated",
  basis: "version",
  runs_sampled: 12,
  runs_per_month: 30.42,
  per_run_amount: 0.138,
  monthly_amount: 4.2,
  currency: "EUR",
  unpriced_models: [],
  rates_basis: "current",
};

function words(projection: ScheduleCostProjection, locale: Locale) {
  return scheduleCostWords(
    projection,
    (key, values) => translate(locale, key, values),
    (key, count) => translatePlural(locale, key, count),
    locale,
  );
}

describe("formatMoney", () => {
  test("formats an amount in the locale's currency style", () => {
    expect(formatMoney("de", 4.2, "EUR")).toBe("4,20 €");
    expect(formatMoney("en", 4.2, "EUR")).toBe("€4.20");
    expect(formatMoney("en", 1234.5, "USD")).toBe("$1,234.50");
  });

  test("falls back to the code for an unknown currency", () => {
    expect(formatMoney("de", 4.2, "not-a-currency")).toBe("4,20 not-a-currency");
  });
});

describe("scheduleCostWords", () => {
  test("names the monthly estimate and its basis in German", () => {
    expect(words(estimated, "de")).toEqual({
      amount: "≈ 4,20 € / Monat",
      basis: "aus 12 Runs, aktuelle Modellpreise",
      estimated: true,
    });
  });

  test("names the monthly estimate and its basis in English", () => {
    expect(words({ ...estimated, runs_sampled: 1 }, "en")).toEqual({
      amount: "≈ €4.20 / month",
      basis: "from 1 run, current model prices",
      estimated: true,
    });
  });

  test("says the estimate comes from earlier versions when the current one has not run", () => {
    expect(words({ ...estimated, basis: "workflow", runs_sampled: 3 }, "de").basis).toBe(
      "aus 3 Runs früherer Versionen, aktuelle Modellpreise",
    );
  });

  test("says when models without a price are left out", () => {
    expect(words({ ...estimated, unpriced_models: ["local"] }, "en").basis).toBe(
      "from 12 runs, current model prices. Models without a price are left out.",
    );
  });

  test("says there is no estimate yet without a finished run", () => {
    expect(
      words(
        {
          ...estimated,
          state: "no_history",
          basis: null,
          runs_sampled: 0,
          per_run_amount: null,
          monthly_amount: null,
        },
        "de",
      ),
    ).toEqual({
      amount: "Noch keine Schätzung",
      basis: "Die Schätzung erscheint nach dem ersten abgeschlossenen Run.",
      estimated: false,
    });
  });
});
