import { describe, expect, test } from "bun:test";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import builtinTemplates from "../templates.json";

const findRecipeWorkflow = (recipeSlug: string): unknown =>
  (builtinTemplates as Array<{ recipes?: Array<{ slug: string; workflow: unknown }> }>)
    .flatMap((template) => template.recipes ?? [])
    .find((recipe) => recipe.slug === recipeSlug)?.workflow;

describe("atomic-debit-credit-double-entry recipe", () => {
  test("guards both legs with expected_row_count after schema parsing", () => {
    const parsed = WorkflowDefSchema.parse(findRecipeWorkflow("atomic-debit-credit-double-entry"));
    const [transferStep] = parsed.steps;
    expect(transferStep?.kind).toBe("request");
    if (transferStep?.kind !== "request") return;
    expect(transferStep.expected_row_count).toBe(1);
    expect(transferStep.sql?.also?.[0]?.expected_row_count).toBe(1);
  });
});
