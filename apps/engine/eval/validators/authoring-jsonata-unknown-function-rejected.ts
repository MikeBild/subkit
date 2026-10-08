import { runAuthoringPipeline } from "../../src/conversations/authoring-pipeline.ts";
import { verifyWorkflow } from "../../src/conversations/verifier.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import { validateWorkflowDef } from "../../src/workflows/validator.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Definition {
  slug: string;
  steps: Array<Record<string, unknown>>;
  output_transform: string;
}

interface Input {
  goal: string;
  first_definition: Definition;
  second_definition: Definition;
  expect: {
    attempts: number;
    finding_path: string;
    finding_message: string;
    second_prompt_must_contain: string[];
    first_prompt_must_contain: string[];
  };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();

  const fileValidation = validateWorkflowDef(input.first_definition);
  c.check(!fileValidation.ok, "file-authoring validator accepted the $indexOf definition");
  const fileError = fileValidation.errors.find((e) => e.path === input.expect.finding_path);
  c.check(
    fileError?.message === input.expect.finding_message,
    `validator message differs: ${JSON.stringify(fileError)}`,
  );

  const verifierError = verifyWorkflow(input.first_definition).errors.find(
    (e) => e.code === "jsonata_unknown_function",
  );
  c.check(
    verifierError?.message === input.expect.finding_message &&
      verifierError.path === input.expect.finding_path,
    `verifier message differs: ${JSON.stringify(verifierError)}`,
  );
  if (c.failed) return { pass: false, reason: c.failed };

  return withAuthoringEvalEnv("jsonata_unknown", async (env) => {
    let generatePasses = 0;
    getMockProvider().generateOverrides.generate = () => {
      generatePasses += 1;
      return generatePasses === 1 ? input.first_definition : input.second_definition;
    };
    const toolCtx = env.makeToolCtx();

    const { result, fetch_calls } = await withEgressTripwire(() =>
      runAuthoringPipeline({ ctx: toolCtx, goal: input.goal }),
    );

    c.check(result.ok, `pipeline failed: ${result.ok ? "" : result.message}`);
    if (!result.ok) return { pass: false, reason: c.failed ?? "pipeline failed" };

    c.check(
      result.attempts === input.expect.attempts,
      `expected ${input.expect.attempts} generation passes, spent ${result.attempts}`,
    );
    c.check(
      result.definition.output_transform === input.second_definition.output_transform,
      "the accepted definition is not the repaired second pass",
    );
    c.check(
      result.validation.ok,
      `complete-artifact validation failed: ${JSON.stringify(result.validation.errors)}`,
    );

    const stashed = toolCtx.current().workflow;
    c.check(
      stashed?.output_transform === input.second_definition.output_transform,
      "the $indexOf definition reached the conversation draft",
    );

    const generateCalls = getMockProvider().calls.filter((call) => call.flow === "generate");
    c.check(generateCalls.length === 2, `expected 2 generate calls, saw ${generateCalls.length}`);
    const firstPrompt = generateCalls[0]?.last_user ?? "";
    for (const needle of input.expect.first_prompt_must_contain) {
      c.check(firstPrompt.includes(needle), `first prompt is missing: ${JSON.stringify(needle)}`);
    }
    const secondPrompt = generateCalls[1]?.last_user ?? "";
    for (const needle of input.expect.second_prompt_must_contain) {
      c.check(secondPrompt.includes(needle), `second prompt is missing: ${JSON.stringify(needle)}`);
    }

    c.check(
      fetch_calls === 0,
      `egress tripwire: ${fetch_calls} live HTTP attempt(s) inside the pipeline`,
    );

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { llm_passes: result.attempts, fetch_calls } };
  });
}
