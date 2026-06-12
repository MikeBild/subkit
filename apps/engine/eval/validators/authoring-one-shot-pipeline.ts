// Authoring scenario (Fix E / CI mode): the `author_workflow` one-shot
// pipeline contract. One goal in, against the deterministic mock LLM
// provider:
//
//   - a schema-valid COMPLETE definition comes back (validation green),
//   - JS-first: authored transforms keep `language: "javascript"` and
//     the ONE generation prompt carries the verbatim JS function-body
//     contract (`FUNCTION BODY`, `input.scope.<step_id>.data`,
//     `input.input`) plus the item_var retirement,
//   - the recorded-eval report is attached with zero compile errors,
//   - the goal is stashed on the conversation draft (the preview judge
//     reads it after dry_run),
//   - `next` is exactly `dry_run_workflow`,
//   - exactly ONE generation pass was spent, and zero live HTTP fired.

import { runAuthoringPipeline } from "../../src/conversations/authoring-pipeline.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Input {
  goal: string;
  generated_definition: Record<string, unknown>;
  expect: {
    slug: string;
    attempts: number;
    next: string;
    transform_language: string;
    prompt_must_contain: string[];
  };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("one_shot", async (env) => {
    getMockProvider().generateOverrides.generate = () => input.generated_definition;
    const toolCtx = env.makeToolCtx();

    const { result, fetch_calls } = await withEgressTripwire(() =>
      runAuthoringPipeline({ ctx: toolCtx, goal: input.goal }),
    );

    const c = new Checks();
    c.check(result.ok, `pipeline failed: ${result.ok ? "" : result.message}`);
    if (!result.ok) return { pass: false, reason: c.failed ?? "pipeline failed" };

    c.check(
      result.attempts === input.expect.attempts,
      `expected ${input.expect.attempts} generation pass(es), spent ${result.attempts}`,
    );
    c.check(
      result.next === input.expect.next,
      `next action is ${result.next}, expected ${input.expect.next}`,
    );
    c.check(
      result.validation.ok,
      `complete-artifact validation failed: ${JSON.stringify(result.validation.errors)}`,
    );
    c.check(
      result.definition.slug === input.expect.slug,
      `slug ${result.definition.slug} != ${input.expect.slug}`,
    );

    // JS-first transform contract survives the pipeline verbatim.
    const transform = result.definition.steps.find((s) => s.kind === "transform");
    c.check(
      transform?.language === input.expect.transform_language,
      `authored transform language is ${String(transform?.language)}, expected ${input.expect.transform_language}`,
    );

    // Recorded evaluation attached, expressions compiled.
    const compileErrors = result.recorded_eval.expressions.filter(
      (f) => f.status === "compile_error",
    );
    c.check(
      compileErrors.length === 0,
      `recorded_eval reported compile errors: ${JSON.stringify(compileErrors)}`,
    );

    // Goal stashed on the draft for the preview judge.
    const draft = toolCtx.current();
    c.check(
      (draft.workflow as { goal?: string } | undefined)?.goal === input.goal,
      "goal was not stashed on the workflow draft",
    );
    c.check(
      draft.workflow?.slug === input.expect.slug,
      "definition was not stashed as the conversation draft",
    );

    // The ONE generation prompt carries the authoring contracts.
    const generateCalls = getMockProvider().calls.filter((call) => call.flow === "generate");
    c.check(generateCalls.length === 1, `expected 1 generate call, saw ${generateCalls.length}`);
    const prompt = generateCalls[0]?.last_user ?? "";
    for (const needle of input.expect.prompt_must_contain) {
      c.check(prompt.includes(needle), `generation prompt is missing: ${JSON.stringify(needle)}`);
    }

    c.check(
      fetch_calls === 0,
      `egress tripwire: ${fetch_calls} live HTTP attempt(s) inside the pipeline`,
    );

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { llm_passes: result.attempts, fetch_calls } };
  });
}
