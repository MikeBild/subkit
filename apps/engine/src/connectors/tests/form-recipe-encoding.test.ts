import { describe, expect, test } from "bun:test";
import { getBuiltinTemplate } from "../templates.ts";

type RecipeStep = {
  kind: string;
  id: string;
  headers?: Record<string, string>;
  body?: unknown;
  expression?: string;
};

const formRecipes = [
  { template: "twilio", slug: "send-sms", fields: ["From", "To", "Body"] },
  { template: "twilio", slug: "send-whatsapp", fields: ["From", "To", "Body"] },
  { template: "slack", slug: "upload-file", fields: ["channels", "filename", "content"] },
] as const;

const sampleValues = ["+12025550111", "+12025550112", "Rappel café – 15:00 + 5 min & merci."];

const recipeSteps = (template: string, slug: string): RecipeStep[] => {
  const recipe = getBuiltinTemplate(template)?.recipes.find((candidate) => candidate.slug === slug);
  expect(recipe).toBeDefined();
  return (recipe?.workflow as { steps: RecipeStep[] } | undefined)?.steps ?? [];
};

const isFormEncoded = (step: RecipeStep) =>
  Object.entries(step.headers ?? {}).some(
    ([name, value]) =>
      name.toLowerCase() === "content-type" && value.includes("application/x-www-form-urlencoded"),
  );

describe("form-urlencoded recipes encode every field value", () => {
  for (const { template, slug, fields } of formRecipes) {
    test(`${template}/${slug} sends no raw-interpolated form body`, () => {
      const formRequests = recipeSteps(template, slug).filter(
        (step) => step.kind === "request" && isFormEncoded(step),
      );
      expect(formRequests.length).toBe(1);
      for (const step of formRequests)
        expect(typeof step.body === "string" && step.body.includes("${input.")).toBe(false);
    });

    test(`${template}/${slug} form transform keeps '+', '&' and unicode intact`, () => {
      const formStep = recipeSteps(template, slug).find(
        (step) => step.kind === "transform" && step.id === "form",
      );
      expect(formStep?.expression).toBeDefined();
      const runInput: Record<string, string> = Object.fromEntries(
        fields.map((field, index) => [field, sampleValues[index] ?? ""]),
      );
      const encoded = new Function("input", formStep?.expression ?? "")({
        input: runInput,
        scope: {},
      }) as string;
      const parsed = new URLSearchParams(encoded);
      expect([...parsed.keys()]).toEqual([...fields]);
      for (const field of fields) expect(parsed.get(field)).toBe(runInput[field] ?? null);
    });
  }
});
