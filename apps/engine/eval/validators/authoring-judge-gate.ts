// Authoring scenario (Fix E / CI mode): the instruction-grounded
// preview judge gates the green-preview auto-commit on the user's goal.
//
// The mock judge is CONTENT-DRIVEN, not call-ordered: it reads the
// judge prompt it receives (goal + recorded step artifacts) and fails
// exactly when the previewed output carries the empty-project-names
// marker — the "Project: ()" incident shape. That proves the wiring
// end-to-end: the dry-run feeds the REAL preview artifacts to the
// judge, a failed verdict blocks the auto-commit and joins the
// requires_repair path with the missing items attached, and the
// correct-content preview auto-commits with a passing verdict.

import { dryRunWorkflowTool } from "../../src/conversations/tools/dry-run-workflow.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv } from "./shared/authoring-env.ts";

interface Verdict {
  verdict: string;
  reason: string;
  missing: string[];
}

interface Input {
  goal: string;
  wrong_expression: string;
  correct_expression: string;
  /** Substring of the judge prompt that identifies the wrong-content
   *  preview (empty project name in the recorded artifacts). */
  empty_name_marker: string;
  failed_verdict: Verdict;
  passing_verdict: Verdict;
}

interface JudgeEnvelope {
  auto_committed?: boolean;
  classification?: string;
  judge?: { verdict: string; reason: string; missing?: string[] };
  warnings?: Array<{ code: string; message: string }>;
  next_best_actions?: string[];
}

function previewableDraft(slug: string, goal: string, expression: string): DraftDocument {
  return {
    workflow: {
      name: slug,
      slug,
      goal,
      steps: [{ id: "shape-email", kind: "transform", language: "jsonata", expression }],
    },
  } as unknown as DraftDocument;
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("judge_gate", async (env) => {
    // Content-driven verdict: failed iff the artifacts carry the
    // empty-name marker. The prompt the override sees IS the judge
    // prompt, so this also pins that real preview artifacts reach it.
    getMockProvider().generateOverrides.judge = (last: string) =>
      last.includes(input.empty_name_marker) ? input.failed_verdict : input.passing_verdict;

    const c = new Checks();

    // ── Wrong-content green preview: judge blocks the auto-commit ──
    const wrongCtx = env.makeToolCtx(
      previewableDraft("eval-judge-blocks", input.goal, input.wrong_expression),
    );
    const blocked = await dryRunWorkflowTool.execute(wrongCtx, { input: null });
    c.check(
      blocked.ok === false,
      "wrong-content preview was NOT blocked (result.ok should be false)",
    );
    const blockedData = blocked.data as JudgeEnvelope;
    c.check(blockedData.auto_committed === undefined, "blocked preview must not auto-commit");
    c.check(
      blockedData.classification === "needs_repair",
      `blocked preview classification is ${String(blockedData.classification)}, expected needs_repair`,
    );
    c.check(
      blockedData.judge?.verdict === input.failed_verdict.verdict,
      `judge verdict is ${String(blockedData.judge?.verdict)}, expected ${input.failed_verdict.verdict}`,
    );
    c.check(
      JSON.stringify(blockedData.judge?.missing) === JSON.stringify(input.failed_verdict.missing),
      "missing items did not ride the blocked result",
    );
    c.check(
      (blockedData.warnings ?? []).some((w) => w.code === "judge_goal_mismatch"),
      "judge_goal_mismatch warning missing from the blocked envelope",
    );
    c.check(
      (blockedData.next_best_actions ?? []).includes("edit_workflow_patch"),
      "blocked envelope must point repair at edit_workflow_patch",
    );
    c.check(
      wrongCtx.current().latest_preview?.requires_repair === true,
      "blocked preview did not join the requires_repair path on the draft",
    );
    c.check(
      wrongCtx.current().state?.judge_breaker?.blocks === 1,
      "judge breaker did not record the block",
    );

    // ── Correct-content preview: judge passes, auto-commit proceeds ──
    const rightCtx = env.makeToolCtx(
      previewableDraft("eval-judge-passes", input.goal, input.correct_expression),
    );
    const committed = await dryRunWorkflowTool.execute(rightCtx, { input: null });
    c.check(committed.ok === true, "correct-content preview did not come back green");
    const committedData = committed.data as JudgeEnvelope;
    c.check(
      committedData.auto_committed === true,
      "correct-content green preview did not auto-commit",
    );
    c.check(
      committedData.judge?.verdict === input.passing_verdict.verdict,
      `passing verdict is ${String(committedData.judge?.verdict)}, expected ${input.passing_verdict.verdict}`,
    );

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true };
  });
}
