// Authoring scenario (Fix E / CI mode): the repair round-trip. A
// recorded-eval finding (broken JS function body that returns an empty
// result against the recorded scope) earns a bounded, mechanically
// VERIFIED repair proposal; ONE `edit_workflow_patch` applies it; the
// recorded evaluation that rides the patch envelope is green. The
// whole loop runs against recorded evidence only — zero live HTTP.

import { runRecordedEval } from "../../src/conversations/recorded-eval.ts";
import { stepFingerprint } from "../../src/conversations/step-fingerprint.ts";
import { editWorkflowPatchTool } from "../../src/conversations/tools/edit-workflow-patch.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Input {
  broken_expression: string;
  repaired_expression: string;
  recorded_output: Record<string, unknown>;
  expect: { finding_site: string; finding_status: string };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("repair_rt", async (env) => {
    const fetchStep = {
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "https://api.example.com/items",
    };
    const brokenShape = {
      id: "shape",
      kind: "transform",
      language: "javascript",
      expression: input.broken_expression,
    };
    const latest_preview = {
      ok: true,
      step_id: "fetch",
      summary: "ok",
      step_traces: [
        {
          step_id: "fetch",
          kind: "request",
          status: "succeeded",
          fingerprint: stepFingerprint(fetchStep),
          output_preview: input.recorded_output,
        },
      ],
    };

    getMockProvider().generateOverrides.repair = () => ({
      expression: input.repaired_expression,
    });

    const c = new Checks();

    // ── 1. Recorded eval surfaces the finding WITH a verified repair ──
    const { result: report, fetch_calls: evalFetchCalls } = await withEgressTripwire(() =>
      runRecordedEval(
        { steps: [fetchStep, brokenShape] },
        { latest_preview: latest_preview as never },
        { repair: { tenant_id: env.tenant_id, db: env.db } },
      ),
    );
    c.check(
      evalFetchCalls === 0,
      `egress tripwire: ${evalFetchCalls} live HTTP attempt(s) during recorded eval`,
    );
    const finding = report.expressions.find((f) => f.site === input.expect.finding_site);
    c.check(
      finding?.status === input.expect.finding_status,
      `finding status is ${String(finding?.status)}, expected ${input.expect.finding_status}`,
    );
    c.check(finding?.repair?.repaired === true, "no verified repair proposal rode the finding");
    const repairOutcome = finding?.repair;
    const proposed = repairOutcome?.repaired ? repairOutcome.after : null;
    c.check(
      proposed === input.repaired_expression,
      `repair proposed ${JSON.stringify(proposed)}, expected ${JSON.stringify(input.repaired_expression)}`,
    );
    if (c.failed) return { pass: false, reason: c.failed };

    // ── 2. ONE edit_workflow_patch applies the proposal → green ──
    const toolCtx = env.makeToolCtx({
      workflow: {
        name: "eval-repair-roundtrip",
        slug: "eval-repair-roundtrip",
        steps: [fetchStep, brokenShape],
      },
      latest_preview,
    } as unknown as DraftDocument);

    const { result: patched, fetch_calls: patchFetchCalls } = await withEgressTripwire(() =>
      editWorkflowPatchTool.execute(toolCtx, {
        patches: [{ op: "replace", path: "/steps/1/expression", value: proposed }],
      }),
    );
    c.check(
      patchFetchCalls === 0,
      `egress tripwire: ${patchFetchCalls} live HTTP attempt(s) during the patch`,
    );
    c.check(patched.ok === true, "edit_workflow_patch refused the verified repair");
    const data = patched.data as { recorded_eval?: { ok: boolean; summary: string } };
    c.check(
      data.recorded_eval?.ok === true,
      `post-patch recorded eval is not green: ${String(data.recorded_eval?.summary)}`,
    );
    const draftSteps = toolCtx.current().workflow?.steps as Array<Record<string, unknown>>;
    c.check(
      draftSteps?.[1]?.expression === input.repaired_expression,
      "patched draft does not carry the repaired expression",
    );

    if (c.failed) return { pass: false, reason: c.failed };
    return {
      pass: true,
      metrics: { repair_attempts: finding?.repair?.repaired ? finding.repair.attempts : -1 },
    };
  });
}
