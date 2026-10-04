import { getBuiltinTemplate } from "../../src/connectors/templates.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  template_slug: string;
  recipe_slug: string;
  expected_max_llm_tokens_per_run: number;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const template = getBuiltinTemplate(input.template_slug);
  if (!template) {
    return { pass: false, reason: `template ${input.template_slug} not loadable` };
  }
  const recipe = template.recipes.find((r) => r.slug === input.recipe_slug);
  if (!recipe) {
    return {
      pass: false,
      reason: `recipe ${input.template_slug}.${input.recipe_slug} not found`,
    };
  }
  const declared = (recipe.workflow as { max_llm_tokens_per_run?: unknown }).max_llm_tokens_per_run;
  if (typeof declared !== "number" || declared <= 0) {
    return {
      pass: false,
      reason: `workflow.max_llm_tokens_per_run expected positive number, got ${JSON.stringify(declared)}; budgeted-LLM primitive coverage regressed`,
    };
  }
  if (declared !== input.expected_max_llm_tokens_per_run) {
    return {
      pass: false,
      reason: `workflow.max_llm_tokens_per_run expected ${input.expected_max_llm_tokens_per_run}, got ${declared}`,
    };
  }
  return {
    pass: true,
    metrics: {
      max_llm_tokens_per_run: declared,
    },
  };
}
