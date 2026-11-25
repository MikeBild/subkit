import { describe, expect, test } from "bun:test";
import { getBuiltinTemplate } from "../templates.ts";

type RecipeStep = {
  kind: string;
  id: string;
  headers?: Record<string, string>;
  body?: unknown;
  expression?: string;
  form?: unknown;
  idempotency_key?: unknown;
};

const formRecipes = [
  { template: "twilio", slug: "send-sms", fields: ["From", "To", "Body"], formSteps: ["form"] },
  {
    template: "twilio",
    slug: "send-whatsapp",
    fields: ["From", "To", "Body"],
    formSteps: ["form"],
  },
  {
    template: "slack",
    slug: "upload-file",
    fields: ["channels", "filename", "content"],
    formSteps: ["form"],
  },
  {
    template: "stripe",
    slug: "create-customer-idempotent",
    fields: ["email"],
    formSteps: ["form"],
  },
] as const;

const stripeFormRecipeSlugs = ["create-customer-idempotent", "charge-or-refund-by-amount"] as const;

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
  for (const { template, slug, fields, formSteps } of formRecipes) {
    test(`${template}/${slug} sends no raw-interpolated form body`, () => {
      const formRequests = recipeSteps(template, slug).filter(
        (step) => step.kind === "request" && isFormEncoded(step),
      );
      expect(formRequests.length).toBe(formSteps.length);
      for (const step of formRequests)
        expect(typeof step.body === "string" && step.body.includes("${input.")).toBe(false);
    });

    test(`${template}/${slug} form transform keeps '+', '&' and unicode intact`, () => {
      const formStep = recipeSteps(template, slug).find(
        (step) => step.kind === "transform" && step.id === formSteps[0],
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

describe("stripe form recipes send a body and a stable idempotency key", () => {
  for (const slug of stripeFormRecipeSlugs) {
    test(`stripe/${slug} request steps carry no unsupported form or idempotency_key field`, () => {
      for (const step of recipeSteps("stripe", slug).filter((step) => step.kind === "request")) {
        expect(step.form).toBeUndefined();
        expect(step.idempotency_key).toBeUndefined();
      }
    });

    test(`stripe/${slug} form POSTs send an encoded body and an input-only Idempotency-Key`, () => {
      const steps = recipeSteps("stripe", slug);
      const formRequests = steps.filter((step) => step.kind === "request" && isFormEncoded(step));
      expect(formRequests.length).toBeGreaterThan(0);
      for (const step of formRequests) {
        const formStepId = /^\$\{scope\.([a-z_]+)\.data\}$/.exec(String(step.body))?.[1];
        expect(
          steps.some((candidate) => candidate.kind === "transform" && candidate.id === formStepId),
        ).toBe(true);
        const idempotencyKey = Object.entries(step.headers ?? {}).find(
          ([name]) => name.toLowerCase() === "idempotency-key",
        )?.[1];
        expect(idempotencyKey).toBeDefined();
        const placeholders = [...String(idempotencyKey).matchAll(/\$\{([^}]+)\}/g)].map(
          (match) => match[1],
        );
        expect(placeholders.length).toBeGreaterThan(0);
        for (const placeholder of placeholders)
          expect(placeholder?.startsWith("input.")).toBe(true);
      }
    });
  }

  test("stripe/charge-or-refund-by-amount encodes the charge and the absolute refund amount", () => {
    const steps = recipeSteps("stripe", "charge-or-refund-by-amount");
    const runTransform = (
      id: string,
      runInput: Record<string, unknown>,
      scope: Record<string, unknown>,
    ) =>
      new URLSearchParams(
        new Function("input", steps.find((step) => step.id === id)?.expression ?? "")({
          input: runInput,
          scope,
        }) as string,
      );
    const charge = runTransform("charge_form", { customer_id: "cus_+&é", amount: 5000 }, {});
    expect(Object.fromEntries(charge)).toEqual({
      customer: "cus_+&é",
      amount: "5000",
      currency: "usd",
    });
    const refund = runTransform(
      "refund_form",
      { customer_id: "cus_1", amount: -1200 },
      { list_for_refund: { data: { data: [{ id: "ch_+&1" }] } } },
    );
    expect(Object.fromEntries(refund)).toEqual({ charge: "ch_+&1", amount: "1200" });
  });
});
