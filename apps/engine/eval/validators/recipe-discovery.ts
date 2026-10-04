import { getBuiltinTemplate } from "../../src/connectors/templates.ts";
import { formatConnectorRecipes } from "../../src/llm/core/context-assembler.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as { template_slug: string; expected_recipe_slugs: string[] };
  const template = getBuiltinTemplate(input.template_slug);
  if (!template) {
    return { pass: false, reason: `template ${input.template_slug} not loadable` };
  }
  if (template.recipes.length === 0) {
    return { pass: false, reason: `template ${input.template_slug} ships no recipes` };
  }
  const block = formatConnectorRecipes(
    input.template_slug,
    template as unknown as Record<string, unknown>,
  );
  if (!block) return { pass: false, reason: "formatConnectorRecipes returned null" };
  const fails: string[] = [];
  for (const slug of input.expected_recipe_slugs) {
    if (!block.includes(`\`${slug}\``)) fails.push(`missing recipe ${slug}`);
  }
  if (!block.includes("start_workflow_from_recipe")) {
    fails.push("missing tool-name hint `start_workflow_from_recipe`");
  }
  if (fails.length > 0) return { pass: false, reason: fails.join("; ") };
  return { pass: true };
}
