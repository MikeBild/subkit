import { describe, expect, test } from "bun:test";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { getBuiltinTemplate } from "../templates.ts";

const formTemplates = [
  "aws-cloudwatch-alarms",
  "aws-cloudwatch-metrics",
  "aws-sts",
  "oauth2-generic",
];

const recipeWorkflows = formTemplates.flatMap((templateSlug) =>
  (getBuiltinTemplate(templateSlug)?.recipes ?? []).map((recipe) => ({
    label: `${templateSlug}/${recipe.slug}`,
    workflow: recipe.workflow,
  })),
);

describe("form-field recipes keep their form after parsing", () => {
  for (const { label, workflow } of recipeWorkflows)
    test(`${label} sends a non-empty form body`, () => {
      const parsed = WorkflowDefSchema.parse(workflow);
      const formRequests = parsed.steps.filter(
        (step) => step.kind === "request" && "form" in step && step.form !== undefined,
      );
      expect(formRequests.length).toBeGreaterThan(0);
      for (const step of formRequests) {
        const form = step.kind === "request" && "form" in step ? step.form : undefined;
        const encoded = new URLSearchParams(
          Object.entries(form ?? {}).map(([name, value]) => [name, String(value)]),
        ).toString();
        expect(encoded.length).toBeGreaterThan(0);
      }
    });
});
