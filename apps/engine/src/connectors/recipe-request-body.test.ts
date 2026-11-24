import { describe, expect, test } from "bun:test";
import { RequestStepSchema, WorkflowDefSchema } from "../workflows/types.ts";
import { getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

describe("recipe request steps survive WorkflowDefSchema parsing (#533)", () => {
  type RawStep = Record<string, unknown> & { kind?: unknown; id?: unknown };
  const collectRequestSteps = (node: unknown): RawStep[] =>
    Array.isArray(node)
      ? node.flatMap(collectRequestSteps)
      : node && typeof node === "object"
        ? [
            ...((node as RawStep).kind === "request" ? [node as RawStep] : []),
            ...Object.values(node).flatMap(collectRequestSteps),
          ]
        : [];
  const strippedKeysTrackedInIssue542 = ["form"];
  const requestStepKeys = new Set([
    ...Object.keys(RequestStepSchema.shape),
    ...strippedKeysTrackedInIssue542,
  ]);
  const recipes = loadBuiltinTemplates().flatMap((template) =>
    template.recipes.map((recipe) => ({ label: `${template.slug}/${recipe.slug}`, recipe })),
  );

  test("no request step carries keys the schema would silently strip", () => {
    const strippedKeys = recipes.flatMap(({ label, recipe }) =>
      collectRequestSteps(recipe.workflow.steps).flatMap((step) =>
        Object.keys(step)
          .filter((key) => !requestStepKeys.has(key))
          .map((key) => `${label}#${String(step.id)}.${key}`),
      ),
    );
    expect(strippedKeys).toEqual([]);
  });

  test("request step body is unchanged after WorkflowDefSchema.parse", () => {
    for (const { recipe } of recipes) {
      const rawSteps = collectRequestSteps(recipe.workflow.steps);
      const parsedSteps = collectRequestSteps(
        WorkflowDefSchema.parse(JSON.parse(JSON.stringify(recipe.workflow))).steps,
      );
      expect(parsedSteps.map((step) => step.body)).toEqual(rawSteps.map((step) => step.body));
    }
  });

  test("delegated-triage-via-call keeps the issue payload as body", () => {
    const recipe = getBuiltinTemplate("github")!.recipes.find(
      (r) => r.slug === "delegated-triage-via-call",
    )!;
    const parsed = WorkflowDefSchema.parse(JSON.parse(JSON.stringify(recipe.workflow)));
    const open = parsed.steps.find((step) => step.id === "open") as { body?: unknown };
    expect(open.body).toEqual({ title: "${input.title}", body: "${input.body}" });
  });
});
