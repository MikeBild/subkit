// Authoring scenario (Fix E / CI mode): the preview-judge circuit
// breaker. A judge that keeps failing the SAME definition must not
// become the next authoring deadlock — after `max_blocks` blocks the
// breaker breaks the edit LOOP but NOT the quality gate: the still-failing
// preview is HELD (never auto-committed — that minted empty / goal-violating
// workflows), and a terminal done-signal (`judge_done.committed_as_is: false`)
// is surfaced so the model stops re-running dry_run_workflow and asks the
// user. The counter holds at the cap (only a real commit resets it).

import { JUDGE_BREAKER_MAX_BLOCKS } from "../../src/conversations/preview-judge.ts";
import { dryRunWorkflowTool } from "../../src/conversations/tools/dry-run-workflow.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv } from "./shared/authoring-env.ts";

interface Input {
  goal: string;
  expression: string;
  failed_verdict: { verdict: string; reason: string; missing: string[] };
  max_blocks: number;
}

interface JudgeEnvelope {
  auto_committed?: boolean;
  judge?: { verdict: string };
  judge_done?: { committed_as_is?: boolean };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("judge_breaker", async (env) => {
    const c = new Checks();
    c.check(
      input.max_blocks === JUDGE_BREAKER_MAX_BLOCKS,
      `fixture max_blocks (${input.max_blocks}) drifted from JUDGE_BREAKER_MAX_BLOCKS (${JUDGE_BREAKER_MAX_BLOCKS})`,
    );

    getMockProvider().generateOverrides.judge = () => input.failed_verdict;
    const toolCtx = env.makeToolCtx({
      workflow: {
        name: "eval-judge-breaker",
        slug: "eval-judge-breaker",
        goal: input.goal,
        steps: [
          {
            id: "shape-email",
            kind: "transform",
            language: "javascript",
            expression: input.expression,
          },
        ],
      },
    } as unknown as DraftDocument);

    // Block 1 and 2 — counted against the definition fingerprint.
    for (let i = 1; i <= input.max_blocks; i++) {
      const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
      c.check(result.ok === false, `block ${i}: preview should have been blocked`);
      c.check(
        toolCtx.current().state?.judge_breaker?.blocks_since_commit === i,
        `block ${i}: breaker counter is ${String(toolCtx.current().state?.judge_breaker?.blocks_since_commit)}, expected ${i}`,
      );
    }

    // At the cap: the breaker breaks the edit LOOP but HOLDS the quality
    // gate — the still-failing preview is NOT committed, and a terminal
    // done-signal is surfaced so the model stops re-running and asks the user.
    const held = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    c.check(held.ok === false, "post-cap preview must be HELD (not committed), not succeed");
    const data = held.data as JudgeEnvelope;
    c.check(data.auto_committed !== true, "post-cap unsatisfied preview must NOT auto-commit");
    c.check(
      data.judge_done?.committed_as_is === false,
      "post-cap held preview must surface judge_done.committed_as_is === false",
    );
    c.check(
      data.judge?.verdict === input.failed_verdict.verdict,
      "the failing verdict must still ride the result",
    );
    // No commit happened, so the breaker counter is NOT reset — it holds at
    // the cap so a model that ignores the EXIT keeps hitting the hold branch
    // rather than slipping an unsatisfied commit through.
    c.check(
      toolCtx.current().state?.judge_breaker?.blocks_since_commit === input.max_blocks,
      `held preview must hold the counter at the cap (${input.max_blocks}), got ${String(toolCtx.current().state?.judge_breaker?.blocks_since_commit)}`,
    );

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { blocks_before_hold: input.max_blocks } };
  });
}
