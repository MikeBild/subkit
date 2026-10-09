import { judgePreview } from "../../src/conversations/preview-judge.ts";
import { dryRunWorkflowTool } from "../../src/conversations/tools/dry-run-workflow.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Verdict {
  verdict: string;
  reason: string;
  missing: string[];
}

interface Input {
  goal: string;
  forecast: Record<string, unknown>;
  argmax_output_transform: string;
  output_schema: Record<string, unknown>;
  raw_marker: string;
  failed_verdict: Verdict;
  passing_verdict: Verdict;
  violating_final_output: unknown;
  expect: {
    final_output_heading: string;
    schema_heading: string;
    raw_rule: string;
    shaped_final_output: unknown;
  };
}

interface Envelope {
  classification?: string;
  judge?: { verdict: string; missing?: string[] };
  warnings?: Array<{ code: string }>;
  final_output?: unknown;
}

function finalOutputSection(prompt: string, heading: string): string {
  const tail = prompt.split(heading)[1] ?? "";
  return tail.split("Verdict rules:")[0] ?? "";
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("judge_final", async (env) => {
    const c = new Checks();
    getMockProvider().generateOverrides.judge = (last: string) =>
      finalOutputSection(last, input.expect.final_output_heading).includes(input.raw_marker)
        ? input.failed_verdict
        : input.passing_verdict;
    const judgePrompts = (): string[] =>
      getMockProvider()
        .calls.filter((call) => call.flow === "judge")
        .map((call) => call.last_user);

    const forecastStep = {
      id: "forecast",
      kind: "transform",
      language: "javascript",
      expression: `return ${JSON.stringify(input.forecast)};`,
    };
    const draft = (slug: string, extra: Record<string, unknown>): DraftDocument =>
      ({
        workflow: { name: slug, slug, goal: input.goal, steps: [forecastStep], ...extra },
      }) as unknown as DraftDocument;

    const leakCtx = env.makeToolCtx(draft("eval-judge-raw-leak", {}));
    const { result: leaked, fetch_calls: leakFetch } = await withEgressTripwire(() =>
      dryRunWorkflowTool.execute(leakCtx, { input: null }),
    );
    c.check(leakFetch === 0, `egress tripwire: ${leakFetch} live HTTP attempt(s)`);
    c.check(leaked.ok === false, "raw payload passthrough was NOT blocked by the judge");
    const leakedData = leaked.data as Envelope;
    c.check(
      leakedData.judge?.verdict === input.failed_verdict.verdict,
      `leak verdict is ${String(leakedData.judge?.verdict)}, expected ${input.failed_verdict.verdict}`,
    );
    c.check(
      leakedData.classification === "needs_repair" &&
        (leakedData.warnings ?? []).some((w) => w.code === "judge_goal_mismatch"),
      "leaked preview did not join the needs_repair path",
    );
    const leakPrompt = judgePrompts()[0] ?? "";
    c.check(
      leakPrompt.includes(input.expect.final_output_heading) &&
        leakPrompt.includes(input.expect.raw_rule),
      "judge prompt lacks the final-output section or the raw-payload rule",
    );
    c.check(
      finalOutputSection(leakPrompt, input.expect.final_output_heading).includes(input.raw_marker),
      "the judge did not see the raw payload as the final output",
    );

    const shapedCtx = {
      ...env.makeToolCtx(
        draft("eval-judge-shaped", {
          output_transform: input.argmax_output_transform,
          output_schema: input.output_schema,
        }),
      ),
      permission_mode: "auto" as const,
    };
    const { result: shaped, fetch_calls: shapedFetch } = await withEgressTripwire(() =>
      dryRunWorkflowTool.execute(shapedCtx, { input: null }),
    );
    c.check(shapedFetch === 0, `egress tripwire: ${shapedFetch} live HTTP attempt(s)`);
    c.check(shaped.ok === true, "shaped preview did not come back green");
    const shapedData = shaped.data as Envelope;
    c.check(
      JSON.stringify(shapedData.final_output) === JSON.stringify(input.expect.shaped_final_output),
      `shaped final_output is ${JSON.stringify(shapedData.final_output)}`,
    );
    c.check(
      shapedData.judge?.verdict === input.passing_verdict.verdict,
      `shaped verdict is ${String(shapedData.judge?.verdict)}`,
    );
    const shapedPrompt = judgePrompts()[1] ?? "";
    c.check(
      shapedPrompt.includes(input.expect.schema_heading),
      "judge prompt lacks the output_schema section",
    );

    const violating = await judgePreview({
      goal: input.goal,
      definition_summary: "- forecast (transform)",
      step_artifacts: [],
      final_output: input.violating_final_output,
      output_schema: input.output_schema,
      tenant_id: env.tenant_id,
      db: env.db,
    });
    c.check(
      violating.verdict === "partial" &&
        violating.missing.some((m) => m.startsWith("$output/hottest_day")),
      `schema-violating output was judged ${violating.verdict} (${violating.verdict === "skipped" ? violating.reason : violating.missing.join("; ")})`,
    );

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { judge_calls: judgePrompts().length } };
  });
}
