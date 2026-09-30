import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import { type Locale, translate } from "@/lib/i18n";
import { statusLabel } from "@/lib/status-label";
import {
  type ExecutionOutcome,
  latestFailedRun,
  payloadEvidence,
  rerunFailureText,
  runCauseLinks,
  runOutcomeSentence,
  runStatusSentence,
  runVerdict,
} from "@/pages/runs-model";

const tr =
  (locale: Locale) =>
  (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);
const de = tr("de");
const word = (status: string) => statusLabel(de, status);

function outcome(kind: ExecutionOutcome["kind"], partial: Partial<ExecutionOutcome> = {}) {
  return {
    kind,
    failed_step: null,
    cause_class: null,
    error_code: null,
    connector: null,
    steps: { total: 2, succeeded: 1, failed: 0, held: 1, skipped: 0 },
    output_contract: "none",
    ...partial,
  } satisfies ExecutionOutcome;
}

describe("a held run is not shown as executed", () => {
  const steps = [{ step_key: "publish", output_preview: { body: "draft" }, result_preview: null }];

  test("its badge says prepared, not succeeded — the engine reports it as `succeeded`", () => {
    const verdict = runVerdict("succeeded", outcome("held"), de, word);
    expect(verdict.label).toBe("Vorbereitet");
    expect(verdict.label).not.toBe(word("succeeded"));
    expect(verdict.tone).toBeNull();
  });

  test("its payload is a preview, never 'Ergebnis'", () => {
    expect(payloadEvidence(steps, "succeeded", outcome("held"))).toEqual({
      text: expect.any(String),
      stepKey: null,
      preview: true,
    });
  });

  test("its sentence says the writes were held", () => {
    expect(runOutcomeSentence(outcome("held"), de).plain).toContain("zurückgehalten");
  });

  test("a succeeded run's output is still the result", () => {
    expect(
      payloadEvidence(
        steps,
        "succeeded",
        outcome("succeeded", { steps: { ...outcome("held").steps, held: 0 } }),
      )?.preview,
    ).toBe(false);
  });
});

describe("the run's verdict", () => {
  test("a partly failed run reads 'Teilweise gelaufen' in a warning, not 'Erfolgreich' in red", () => {
    expect(runVerdict("succeeded", outcome("partial"), de, word)).toEqual({
      label: "Teilweise gelaufen",
      tone: "warning",
    });
  });

  test("a failed outcome is critical", () => {
    expect(runVerdict("failed", outcome("failed"), de, word).tone).toBe("critical");
  });

  test("without an outcome every status the engine counts as failed gets a cause block", () => {
    for (const status of ["failed", "timed_out", "aborted"])
      expect(runVerdict(status, null, de, word).tone).toBe("critical");
    for (const status of ["succeeded", "running", "queued"])
      expect(runVerdict(status, null, de, word).tone).toBeNull();
  });

  test("and it says how the run ended even when the engine named no cause", () => {
    expect(runStatusSentence(word("aborted"), de).plain).toContain(word("aborted"));
  });
});

describe("the audit link", () => {
  test("only for a reader who may open the audit trail", () => {
    expect(runCauseLinks("r1", ["execution:read"], de)).toEqual([]);
    expect(runCauseLinks("r1", ["execution:read", "audit:read"], de)).toHaveLength(1);
  });
});

describe("a refused rerun says why", () => {
  test("a known refusal in the cockpit's words", () => {
    const error = new ApiError(409, { code: "workflow_version_unavailable", message: "x" }, null);
    expect(rerunFailureText(error, de)).toBe(de("runs.rerun.refused.versionUnavailable"));
  });
  test("an unknown one as the engine's wording, not a blanket sentence", () => {
    const error = new ApiError(409, { code: "something_new", message: "quota frozen" }, null);
    const text = rerunFailureText(error, de);
    expect(text).toContain("quota frozen");
    expect(text).toContain("Wortlaut der Engine");
  });
});

describe("the newest failed run", () => {
  test("counts a timeout and an abort as failures", () => {
    expect(
      latestFailedRun([{ status: "succeeded" }, { status: "timed_out" }, { status: "failed" }])
        ?.status,
    ).toBe("timed_out");
    expect(latestFailedRun([{ status: "aborted" }])?.status).toBe("aborted");
    expect(latestFailedRun([{ status: "succeeded" }])).toBeNull();
  });
});
