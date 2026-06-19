// Authoring scenario (Fix E / CI mode): the preview-judge circuit
// breaker. A judge that keeps failing the SAME definition must not
// become the next authoring deadlock — after `max_blocks` blocks per
// definition fingerprint, the verdict degrades to advisory: the
// auto-commit proceeds, the (still failing) verdict rides the result,
// and the counter stops incrementing.

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

    // Third identical preview: advisory — the breaker is at the cap, so
    // the verdict degrades to advisory and the auto-commit proceeds with
    // the (still failing) verdict attached.
    const advisory = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    c.check(advisory.ok === true, "post-breaker preview should succeed (advisory verdict)");
    const data = advisory.data as JudgeEnvelope;
    c.check(data.auto_committed === true, "post-breaker green preview must auto-commit");
    c.check(
      data.judge?.verdict === input.failed_verdict.verdict,
      "advisory verdict must still ride the result",
    );
    // The monotonic counter is "blocks since the last commit": the
    // advisory auto-commit clears the breaker, so a subsequent edit gets
    // a fresh judging budget instead of an immediately-degraded judge.
    c.check(
      (toolCtx.current().state?.judge_breaker ?? null) === null,
      "advisory auto-commit must reset the per-draft breaker (blocks-since-commit)",
    );

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { blocks_before_advisory: input.max_blocks } };
  });
}
