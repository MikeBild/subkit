import { describe, expect, test } from "bun:test";
import { type Locale, translate } from "@/lib/i18n";
import { protectedDiagnosticsSentence } from "./runs-model";

const tr =
  (locale: Locale) =>
  (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);

const failedProtectedStep = {
  request_meta: {
    driver: "sensitive",
    connector: { connector_id: "c-1", connector_slug: "crm" },
    status_class: "4xx",
    body_size: "<10KB",
    placeholder_types: { "input.body.app.argv": "array", "input.name": "string" },
  },
};

describe("a protected run explains its failure without its data", () => {
  test("names the status class, the body size and the placeholder types", () => {
    expect(protectedDiagnosticsSentence(failedProtectedStep, tr("en"))).toBe(
      "The service refused the request (4xx). Check the sign-in and the values the step sends. Request body: <10KB. Values used, by type only: input.body.app.argv (array), input.name (string).",
    );
    expect(protectedDiagnosticsSentence(failedProtectedStep, tr("de"))).toBe(
      [
        tr("de")("runs.outcome.protected.status.4xx"),
        tr("de")("runs.outcome.protected.body", { size: "<10KB" }),
        tr("de")("runs.outcome.protected.placeholders", {
          list: "input.body.app.argv (array), input.name (string)",
        }),
      ].join(" "),
    );
  });

  test.each([
    ["2xx", "runs.outcome.protected.status.2xx"],
    ["3xx", "runs.outcome.protected.status.3xx"],
    ["5xx", "runs.outcome.protected.status.5xx"],
    ["network", "runs.outcome.protected.status.network"],
    ["timeout", "runs.outcome.protected.status.timeout"],
  ] as const)("the %s class reads as its own sentence", (statusClass, key) => {
    const step = { request_meta: { driver: "sensitive", status_class: statusClass } };
    for (const locale of ["en", "de"] as const)
      expect(protectedDiagnosticsSentence(step, tr(locale))).toBe(tr(locale)(key));
  });

  test("an ordinary step or a protected step without diagnostics says nothing", () => {
    expect(protectedDiagnosticsSentence(null, tr("en"))).toBeNull();
    expect(protectedDiagnosticsSentence({ request_meta: null }, tr("en"))).toBeNull();
    expect(
      protectedDiagnosticsSentence({ request_meta: { driver: "http", status: 503 } }, tr("en")),
    ).toBeNull();
    expect(
      protectedDiagnosticsSentence({ request_meta: { driver: "sensitive" } }, tr("en")),
    ).toBeNull();
  });
});
