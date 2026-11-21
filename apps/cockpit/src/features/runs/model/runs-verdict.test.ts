import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import { type Locale, translate } from "@/lib/i18n";
import { statusLabel } from "@/lib/status-label";
import { payloadEvidence, runVerdict, truncatedSteps } from "./run-outcome";
import {
  type ExecutionOutcome,
  latestFailedRun,
  rerunFailureText,
  runCauseLinks,
  runOutcomeSentence,
  runStatusSentence,
  runTruncationSentence,
} from "./runs-model";

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
    refusal_reason: null,
    connector: null,
    steps: { total: 2, succeeded: 1, failed: 0, held: 1, skipped: 0 },
    output_contract: "none",
    rerun_safety: { mode: "prepare_only", reason: "Review effects before repeating" },
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

describe("a truncated read is not shown as a plain success", () => {
  const paging = (limit: string | null, truncated = true) => ({
    strategy: "link",
    pages: 3,
    items: 6,
    duplicates_dropped: 0,
    complete: !truncated,
    truncated,
    limit,
  });
  const sealed = { $sensitive: true, ciphertext: "x", iv: "y", auth_tag: "z" };
  const steps = [
    {
      step_key: "commits",
      output_preview: sealed,
      request_meta: { driver: "sensitive", pagination: paging("max_pages") },
      result_preview: null,
    },
    {
      step_key: "issues",
      output_preview: null,
      request_meta: { driver: "http", method: "GET", url: null, pagination: paging("max_items") },
      result_preview: null,
    },
    {
      step_key: "actions",
      output_preview: {
        value: [],
        warnings: [
          { code: "pagination_truncated", message: "limit", details: { limit: "max_bytes" } },
        ],
      },
      result_preview: null,
    },
    {
      step_key: "milestones",
      output_preview: { value: [], warnings: [{ code: "pagination_truncated", message: "x" }] },
      result_preview: null,
    },
    {
      step_key: "repo",
      output_preview: sealed,
      request_meta: { driver: "sensitive", pagination: paging(null, false) },
      result_preview: null,
    },
  ];

  test("stored sensitive, offloaded and inline step shapes name the limit that stopped them", () => {
    expect(truncatedSteps(steps)).toEqual([
      { step: "commits", limit: "max_pages" },
      { step: "issues", limit: "max_items" },
      { step: "actions", limit: "max_bytes" },
      { step: "milestones", limit: null },
    ]);
    expect(truncatedSteps([steps[4]!])).toEqual([]);
  });

  test("a succeeded run with truncated steps reads as partly completed", () => {
    const truncated = truncatedSteps(steps);
    expect(runVerdict("succeeded", outcome("succeeded"), de, word, truncated)).toEqual({
      label: "Teilweise gelaufen",
      tone: "warning",
      truncated: true,
    });
    expect(runVerdict("succeeded", null, de, word, truncated).truncated).toBe(true);
    expect(runVerdict("succeeded", outcome("succeeded"), de, word, []).truncated).toBeUndefined();
    expect(runVerdict("failed", outcome("failed"), de, word, truncated)).toMatchObject({
      tone: "critical",
    });
    expect(runVerdict("failed", outcome("failed"), de, word, truncated).truncated).toBeUndefined();
  });

  test("one short line per affected step names its limit, in both languages", () => {
    const truncated = truncatedSteps(steps);
    expect(runTruncationSentence(truncated, de).plain).toBe(
      "commits: Seitenlimit erreicht, Ergebnis unvollständig. issues: Eintragslimit erreicht, Ergebnis unvollständig. actions: Größenlimit erreicht, Ergebnis unvollständig. milestones: Abruf vorzeitig beendet, Ergebnis unvollständig.",
    );
    expect(runTruncationSentence(truncated, tr("en")).plain).toBe(
      "commits: page limit reached, result incomplete. issues: item limit reached, result incomplete. actions: size limit reached, result incomplete. milestones: paging stopped early, result incomplete.",
    );
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
