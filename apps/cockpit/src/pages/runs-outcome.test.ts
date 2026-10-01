import { describe, expect, test } from "bun:test";
import { causeClassLabel } from "@/lib/cause-class";
import { type Locale, translate } from "@/lib/i18n";
import {
  type ExecutionOutcome,
  payloadEvidence,
  runOutcomeSentence,
  stepConnectorId,
  stoppingStep,
} from "@/pages/runs-model";

const tr =
  (locale: Locale) =>
  (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);
const de = tr("de");
const en = tr("en");

function outcome(partial: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  return {
    kind: "failed",
    failed_step: { step_key: "publish-report", kind: "request" },
    cause_class: "auth_failed",
    error_code: "http_401",
    refusal_reason: null,
    connector: null,
    steps: { total: 3, succeeded: 2, failed: 1, held: 0, skipped: 0 },
    output_contract: "none",
    ...partial,
  };
}

describe("runOutcomeSentence", () => {
  const cases: Array<[string, Partial<ExecutionOutcome>, string, string]> = [
    [
      "failed at a step with a cause",
      {},
      "Abgebrochen bei Schritt „publish-report“ – Ursache: Anmeldung abgelehnt. Zuvor abgeschlossen: 2 von 3 Schritten.",
      "Stopped at step “publish-report” — cause: Sign-in rejected. Completed before that: 2 of 3 steps.",
    ],
    [
      "failed at a step without a class",
      { cause_class: null },
      "Abgebrochen bei Schritt „publish-report“. Zuvor abgeschlossen: 2 von 3 Schritten.",
      "Stopped at step “publish-report”. Completed before that: 2 of 3 steps.",
    ],
    [
      "failed before any step, with a cause",
      {
        failed_step: null,
        cause_class: "budget_exhausted",
        steps: { total: 1, succeeded: 0, failed: 0, held: 0, skipped: 1 },
      },
      "Fehlgeschlagen – Ursache: Token-Budget erschöpft. Abgeschlossen: 0 von 1 Schritt.",
      "Failed — cause: Token budget exhausted. Completed: 0 of 1 step.",
    ],
    [
      "the engine's own 'unknown' class gets words, not 'Unbekannt'",
      { cause_class: "unknown" },
      "Abgebrochen bei Schritt „publish-report“ – Ursache: Nicht eingeordnet. Zuvor abgeschlossen: 2 von 3 Schritten.",
      "Stopped at step “publish-report” — cause: Not classified. Completed before that: 2 of 3 steps.",
    ],
    [
      "succeeded, singular step",
      {
        kind: "succeeded",
        failed_step: null,
        cause_class: null,
        steps: { total: 1, succeeded: 1, failed: 0, held: 0, skipped: 0 },
      },
      "Erfolgreich – 1 von 1 Schritt abgeschlossen.",
      "Succeeded — 1 of 1 step completed.",
    ],
    [
      "succeeded but the output contract was violated",
      {
        kind: "succeeded",
        failed_step: null,
        cause_class: null,
        output_contract: "violated",
        steps: { total: 3, succeeded: 3, failed: 0, held: 0, skipped: 0 },
      },
      "Beendet, aber das Ergebnis verletzt den Ausgabevertrag des Workflows – 3 von 3 Schritten abgeschlossen.",
      "Finished, but the result breaks the workflow's output contract — 3 of 3 steps completed.",
    ],
    [
      "partial with a cause",
      { kind: "partial", failed_step: null, cause_class: "timeout" },
      "Teilweise gelaufen – 2 von 3 Schritten abgeschlossen, 1 fehlgeschlagen. Ursache: Zeitüberschreitung.",
      "Partly completed — 2 of 3 steps completed, 1 failed. Cause: Timed out.",
    ],
    [
      "running",
      { kind: "running", failed_step: null, cause_class: null },
      "Läuft – bisher 2 von 3 Schritten abgeschlossen.",
      "Running — 2 of 3 steps completed so far.",
    ],
  ];
  for (const [name, partial, german, english] of cases) {
    test(name, () => {
      expect(runOutcomeSentence(outcome(partial), de).plain).toBe(german);
      expect(runOutcomeSentence(outcome(partial), en).plain).toBe(english);
    });
  }

  test("a class this build has no word for stays the engine's value, marked as one", () => {
    const sentence = runOutcomeSentence(
      outcome({ cause_class: "quota_melted" as ExecutionOutcome["cause_class"] }),
      de,
    );
    expect(sentence.cause).toEqual({ text: "quota_melted", machine: true });
    expect(sentence.plain).not.toContain("Unbekannt");
    expect(sentence.plain).toContain("quota_melted");
  });

  test("the cause is kept apart so it can be set as a machine value", () => {
    const sentence = runOutcomeSentence(outcome(), de);
    expect(sentence.cause).toEqual({ text: "Anmeldung abgelehnt", machine: false });
    expect(`${sentence.lead}${sentence.cause?.text}${sentence.tail}`).toBe(sentence.plain);
  });
});

describe("causeClassLabel", () => {
  test("every engine class has a word in both locales, and none is 'Unbekannt'", () => {
    const classes = [
      "ok",
      "auth_failed",
      "placeholder_unresolved",
      "schema_mismatch",
      "timeout",
      "aborted",
      "connector_missing",
      "budget_exhausted",
      "connector_unavailable",
      "refused_before_start",
      "driver_error",
      "preview_unsupported",
      "unknown",
    ];
    for (const value of classes)
      for (const t of [de, en]) {
        const label = causeClassLabel(value, t);
        expect(label.machine).toBe(false);
        expect(label.text).not.toMatch(/^unbekannt$|^unknown$/i);
      }
  });

  test("a refused run is not an error in the external system", () => {
    expect(causeClassLabel("connector_unavailable", de).text).toBe("Konnektor nicht verfügbar");
    expect(causeClassLabel("refused_before_start", de).text).toBe("Vor dem Start abgelehnt");
    expect(causeClassLabel("connector_unavailable", en).text).toBe("Connector unavailable");
    expect(causeClassLabel("refused_before_start", en).text).toBe("Refused before the start");
  });
});

describe("which step is the run's error", () => {
  const steps = [
    { step_key: "fetch", error: { message: "soft fail" }, result_preview: null },
    { step_key: "publish-report", error: { message: "401" }, result_preview: null },
  ];
  test("the engine's stopping step, not the first step with an error", () => {
    expect(stoppingStep(steps, outcome())?.step_key).toBe("publish-report");
  });
  test("without an outcome the first erroring step, as before", () => {
    expect(stoppingStep(steps, null)?.step_key).toBe("fetch");
  });
  test("a succeeded run has no stopping step even when a step soft-failed", () => {
    expect(
      stoppingStep(steps, outcome({ kind: "succeeded", failed_step: null, cause_class: null })),
    ).toBeNull();
  });
});

describe("the payload drawer", () => {
  const steps = [
    { step_key: "fetch", output_preview: { rows: 3 }, result_preview: null },
    { step_key: "publish-report", output_preview: null, result_preview: "null" },
  ];
  test("a failed run's last output is labelled with its step, not as the result", () => {
    expect(payloadEvidence(steps, "failed")?.stepKey).toBe("fetch");
  });
  test("a succeeded run's last output is the result", () => {
    expect(payloadEvidence(steps, "succeeded")?.stepKey).toBeNull();
  });
  test("nothing produced means no drawer", () => {
    expect(payloadEvidence([{ step_key: "x", result_preview: "null" }], "failed")).toBeNull();
  });
});

describe("stepConnectorId", () => {
  test("reads the connector the engine recorded", () => {
    expect(
      stepConnectorId({
        step_key: "s",
        result_preview: null,
        request_meta: { connector: { connector_id: "c1", step_key: "s" } },
      }),
    ).toBe("c1");
  });
  test("no connector recorded is null", () => {
    expect(stepConnectorId({ step_key: "s", result_preview: null, request_meta: null })).toBeNull();
  });
});
