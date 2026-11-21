import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  type DryRunStepSummary,
  heldReadHintOf,
  type PreviewDecisionInput,
  type PreviewSummaryInput,
  previewClassification,
  previewDecision,
  previewErrorCode,
  previewSummaryOf,
  totalDurationMs,
} from "./dry-run.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

function step(overrides: Partial<DryRunStepSummary> = {}): DryRunStepSummary {
  return {
    step_key: "s1",
    kind: "request",
    status: "succeeded",
    duration_ms: 12,
    error: null,
    ...overrides,
  };
}

const baseDecision: PreviewDecisionInput = {
  dryRunGreen: true,
  dryRunRequiresRepair: false,
  judgeBlocked: false,
  judgeSkipped: false,
  judgeEscalate: false,
  doneGuidance: null,
  askBeforeWriting: false,
  saveDeclined: false,
  wouldReplacePersisted: false,
  stoppedForDraft: "s9",
};

function decide(overrides: Partial<PreviewDecisionInput>) {
  return previewDecision({ ...baseDecision, ...overrides });
}

describe("previewDecision", () => {
  test("auto-commits a green judged preview", () => {
    expect(decide({})).toEqual({
      cleanPreview: true,
      greenPendingSave: false,
      judgeExhausted: false,
      nextActions: ["save_workflow_draft"],
      nextPrompt: "Committing the workflow",
    });
    expect(decide({ judgeSkipped: true }).cleanPreview).toBe(true);
  });

  test("holds a green unjudged preview that would replace a persisted workflow", () => {
    expect(decide({ judgeSkipped: true, wouldReplacePersisted: true })).toEqual({
      cleanPreview: false,
      greenPendingSave: true,
      judgeExhausted: false,
      nextActions: ["save_workflow_draft"],
      nextPrompt:
        "Preview is green, but no goal was set, so nothing judged it against one — and committing would REPLACE an existing persisted workflow. Not auto-committed. Tell the user which workflow would be replaced and let them decide, then call save_workflow_draft.",
    });
    expect(decide({ wouldReplacePersisted: true }).cleanPreview).toBe(true);
  });

  test("asks for an explicit save when the person asks before writing", () => {
    expect(decide({ askBeforeWriting: true }).nextPrompt).toBe(
      "Preview is green and judged. Call save_workflow_draft so the normal human approval gate decides whether to persist it.",
    );
    expect(decide({ askBeforeWriting: true, judgeSkipped: true }).nextPrompt).toBe(
      "Preview is green — call save_workflow_draft to persist it (the preview was not judged, so it is not auto-committed)",
    );
    expect(decide({ askBeforeWriting: true }).greenPendingSave).toBe(true);
  });

  test("stops when the user declined saving", () => {
    expect(decide({ saveDeclined: true })).toEqual({
      cleanPreview: false,
      greenPendingSave: true,
      judgeExhausted: false,
      nextActions: [],
      nextPrompt:
        "Preview is green. The user asked not to save, so stop here and report the result.",
    });
    expect(decide({ saveDeclined: true, dryRunGreen: false }).nextActions).toEqual([
      "inspect_workflow_draft",
      "edit_workflow_patch",
    ]);
  });

  test("routes a blocked judge to revision, exhaustion or escalation", () => {
    expect(decide({ judgeBlocked: true })).toEqual({
      cleanPreview: false,
      greenPendingSave: false,
      judgeExhausted: false,
      nextActions: ["edit_workflow_patch", "inspect_workflow_draft", "dry_run_workflow"],
      nextPrompt:
        "Revise the workflow so the preview satisfies the goal (edit_workflow_patch), then re-run dry_run_workflow",
    });
    expect(decide({ judgeBlocked: true, doneGuidance: "ask the user" })).toEqual({
      cleanPreview: false,
      greenPendingSave: false,
      judgeExhausted: true,
      nextActions: ["save_workflow_draft", "edit_workflow_patch"],
      nextPrompt: "ask the user",
    });
    expect(
      decide({ judgeBlocked: true, doneGuidance: "escalate", judgeEscalate: true }).nextActions,
    ).toEqual(["save_workflow_draft"]);
    expect(decide({ doneGuidance: "unused" }).judgeExhausted).toBe(false);
  });

  test("routes a red preview to diagnosis or a re-run", () => {
    expect(decide({ dryRunGreen: false, dryRunRequiresRepair: true })).toEqual({
      cleanPreview: false,
      greenPendingSave: false,
      judgeExhausted: false,
      nextActions: ["diagnose_latest_execution", "edit_workflow_patch", "inspect_workflow_draft"],
      nextPrompt: "Open diagnosis to see why the preview needs repair",
    });
    expect(decide({ dryRunGreen: false })).toEqual({
      cleanPreview: false,
      greenPendingSave: false,
      judgeExhausted: false,
      nextActions: ["inspect_workflow_draft", "edit_workflow_patch"],
      nextPrompt: "Re-run preview after fixing step `s9`",
    });
  });

  test("never commits and asks for a save at once, and only commits green unblocked previews", () => {
    fc.assert(
      fc.property(
        fc.record({
          dryRunGreen: fc.boolean(),
          dryRunRequiresRepair: fc.boolean(),
          judgeBlocked: fc.boolean(),
          judgeSkipped: fc.boolean(),
          judgeEscalate: fc.boolean(),
          doneGuidance: fc.option(fc.string(), { nil: null }),
          askBeforeWriting: fc.boolean(),
          saveDeclined: fc.boolean(),
          wouldReplacePersisted: fc.boolean(),
          stoppedForDraft: fc.string(),
        }),
        (input) => {
          const d = previewDecision(input);
          expect(d.cleanPreview && d.greenPendingSave).toBe(false);
          if (d.cleanPreview) {
            expect(input.dryRunGreen && !input.judgeBlocked && !input.askBeforeWriting).toBe(true);
            expect(input.saveDeclined).toBe(false);
          }
          expect(d.judgeExhausted).toBe(input.judgeBlocked && input.doneGuidance !== null);
          expect(d.cleanPreview || d.greenPendingSave).toBe(
            input.dryRunGreen && !input.judgeBlocked,
          );
        },
      ),
      FC,
    );
  });
});

describe("previewErrorCode", () => {
  const failed = [step(), step({ step_key: "b", status: "failed", error: { code: "http_500" } })];

  test("ranks judge escalation, judge failure, step failure and repair", () => {
    const base = { judgeEscalate: false, judgeBlocked: false, runStatus: "succeeded", steps: [] };
    expect(previewErrorCode({ ...base, judgeEscalate: true, judgeBlocked: true })).toBe(
      "preview_judge_exhausted",
    );
    expect(previewErrorCode({ ...base, judgeBlocked: true })).toBe("preview_judge_failed");
    expect(previewErrorCode(base)).toBe("preview_needs_repair");
    expect(previewErrorCode({ ...base, runStatus: "failed", steps: failed })).toBe(
      "draft_step_failed:http_500",
    );
    expect(
      previewErrorCode({ ...base, runStatus: "failed", steps: [step({ status: "skipped" })] }),
    ).toBe("draft_step_failed");
    expect(previewErrorCode({ ...base, runStatus: "failed", steps: [step()] })).toBe(
      "draft_step_failed",
    );
  });
});

const baseSummary: PreviewSummaryInput = {
  runStatus: "succeeded",
  stepsRan: 2,
  stoppedForDraft: "b",
  stoppedMessage: null,
  lastStepSummary: undefined,
  runErrorMessage: undefined,
  judgeOutcome: null,
  judgeBlocked: false,
  doneAttempts: null,
  repairCount: 1,
};

function summarize(overrides: Partial<PreviewSummaryInput>): string {
  return previewSummaryOf({ ...baseSummary, ...overrides });
}

describe("previewSummaryOf", () => {
  test("names the stopped step and the best known reason", () => {
    const failed = { runStatus: "failed" };
    expect(summarize({ ...failed, stoppedMessage: "boom", lastStepSummary: "last" })).toBe(
      "Run stopped at step `b`: boom",
    );
    expect(summarize({ ...failed, lastStepSummary: "last", runErrorMessage: "run" })).toBe(
      "Run stopped at step `b`: last",
    );
    expect(summarize({ ...failed, runErrorMessage: "run" })).toBe("Run stopped at step `b`: run");
    expect(summarize(failed)).toBe("Run stopped at step `b`: unknown error");
  });

  test("explains a blocked judge verdict", () => {
    const judged = {
      judgeBlocked: true,
      judgeOutcome: { verdict: "partial" as const, reason: "half", missing: ["x", "y"] },
    };
    expect(summarize(judged)).toBe(
      "Ran 2 steps without errors, but the preview does not satisfy the user's goal (judge verdict: partial): half Missing: x; y. Fix via edit_workflow_patch and re-run dry_run_workflow — or, after the user explicitly confirms, commit anyway via save_workflow_draft.",
    );
    expect(
      summarize({
        ...judged,
        stepsRan: 1,
        doneAttempts: 3,
        judgeOutcome: { verdict: "failed", reason: "none", missing: [] },
      }),
    ).toBe(
      "Ran 1 step without errors, but after 3 attempts the preview still does not satisfy the user's goal (judge verdict: failed): none It was NOT committed. STOP re-running dry_run_workflow — tell the user what is missing and ask how to proceed, or commit as-is via save_workflow_draft.",
    );
  });

  test("falls back to the repair message", () => {
    expect(summarize({})).toBe(
      "Ran 2 steps, but the preview needs repair — 1 blocking warning. Fix the flagged step before committing.",
    );
    expect(summarize({ stepsRan: 1, repairCount: 2, judgeBlocked: true })).toBe(
      "Ran 1 step, but the preview needs repair — 2 blocking warnings. Fix the flagged step before committing.",
    );
    expect(
      summarize({ repairCount: 0, judgeBlocked: true, judgeOutcome: { verdict: "skipped" } }),
    ).toBe(
      "Ran 2 steps, but the preview needs repair — 0 blocking warnings. Fix the flagged step before committing.",
    );
    expect(
      summarize({
        judgeOutcome: { verdict: "failed", reason: "r", missing: [] },
        doneAttempts: 2,
      }),
    ).toBe(
      "Ran 2 steps, but the preview needs repair — 1 blocking warning. Fix the flagged step before committing.",
    );
  });
});

describe("heldReadHintOf", () => {
  test("explains held writes that left dependents skipped", () => {
    expect(
      heldReadHintOf([
        step({ held: true }),
        step({ held: true }),
        step({ status: "skipped", error: { code: "skipped_dependency_held" } }),
      ]),
    ).toBe(
      '2 step(s) were HELD as writes and 1 dependent step(s) were skipped, so the preview could not produce a complete result. Only a verified read-only HTTP POST search endpoint supports the `side_effects: "read"` override. This label cannot authorize SQL writes, GraphQL mutations, or remote MCP tool calls. Keep those effects held, or request explicit approval for a live write run.',
    );
  });

  test("stays silent without both held and skipped steps", () => {
    expect(heldReadHintOf([step({ held: true }), step({ error: { code: "other" } })])).toBeNull();
    expect(
      heldReadHintOf([step({ error: { code: "skipped_dependency_held" } }), step({ error: null })]),
    ).toBeNull();
    expect(heldReadHintOf([])).toBeNull();
  });
});

describe("totalDurationMs and previewClassification", () => {
  test("sums durations treating null as zero", () => {
    expect(totalDurationMs([{ duration_ms: 5 }, { duration_ms: null }, { duration_ms: 7 }])).toBe(
      12,
    );
    fc.assert(
      fc.property(fc.array(fc.option(fc.nat(1000), { nil: null })), (ds) => {
        const sum = ds.reduce<number>((acc, d) => acc + (d ?? 0), 0);
        expect(totalDurationMs(ds.map((duration_ms) => ({ duration_ms })))).toBe(sum);
      }),
      FC,
    );
  });

  test("classifies repair first, then the last step, then the run status", () => {
    expect(
      previewClassification({
        needsRepair: true,
        lastClassification: "ok",
        runStatus: "succeeded",
      }),
    ).toBe("needs_repair");
    expect(
      previewClassification({
        needsRepair: false,
        lastClassification: "empty",
        runStatus: "failed",
      }),
    ).toBe("empty");
    expect(
      previewClassification({
        needsRepair: false,
        lastClassification: undefined,
        runStatus: "succeeded",
      }),
    ).toBe("ok");
    expect(
      previewClassification({
        needsRepair: false,
        lastClassification: undefined,
        runStatus: "failed",
      }),
    ).toBe("driver_error");
  });
});
