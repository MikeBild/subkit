import { describe, expect, test } from "bun:test";
import { getBuiltinTemplate } from "../connectors/templates.ts";
import { compileRequestBoundary } from "./request-boundary.ts";
import { type RequestStep, RequestStepSchema } from "./types.ts";

const FALLBACK_BASE = "https://auth.example.test";
const formTemplates = [
  "aws-cloudwatch-alarms",
  "aws-cloudwatch-metrics",
  "aws-sts",
  "oauth2-generic",
];

const formSteps = formTemplates.flatMap((templateSlug) => {
  const template = getBuiltinTemplate(templateSlug);
  return (template?.recipes ?? []).flatMap((recipe) =>
    ((recipe.workflow as { steps?: Array<Record<string, unknown>> } | undefined)?.steps ?? [])
      .filter((raw) => raw.kind === "request" && raw.form !== undefined)
      .map((raw) => ({
        label: `${templateSlug}/${recipe.slug}/${String(raw.id)}`,
        raw,
        base_url: template?.base_url ?? FALLBACK_BASE,
      })),
  );
});

const pathVariables = (path: string) =>
  Object.fromEntries(
    [...path.matchAll(/\$\{([^}]+)\}/g)].map((match) => [match[1], { class: "path" as const }]),
  );

const bounded = (raw: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  RequestStepSchema.parse({
    ...raw,
    boundary: {
      variables: pathVariables(String(raw.path ?? "")),
      max_body_bytes: 8192,
      max_calls: 1,
    },
    ...extra,
  }) as RequestStep;

const idempotentStep = (idempotency_key: string, extra: Record<string, unknown> = {}) =>
  RequestStepSchema.parse({
    id: "send",
    kind: "request",
    method: "POST",
    connector_id: "00000000-0000-4000-8000-000000000000",
    path: "/charges",
    form: { amount: "${input.amount}" },
    idempotency_key,
    boundary: {
      variables: { "input.idempotency_key": { class: "identifier" } },
      max_body_bytes: 1024,
      max_calls: 1,
    },
    ...extra,
  }) as RequestStep;

describe("request boundary over form recipes", () => {
  test("every AWS and oauth2-generic form recipe is covered", () => {
    expect(formSteps.length).toBe(18);
  });

  for (const { label, raw, base_url } of formSteps)
    test(`${label} compiles under a boundary`, () => {
      const compiled = compileRequestBoundary(bounded(raw), base_url);
      expect(compiled.refusal).toBeUndefined();
      expect(compiled.boundary?.method).toBe("POST");
    });
});

describe("request boundary over a step idempotency_key", () => {
  test("a whole-placeholder idempotency_key compiles as the reviewed Idempotency-Key", () => {
    const compiled = compileRequestBoundary(
      idempotentStep("${input.idempotency_key}"),
      "https://api.example.test",
    );
    expect(compiled.refusal).toBeUndefined();
    expect(compiled.boundary?.idempotency_key).toEqual({ var: "input.idempotency_key" });
  });

  test("a composite idempotency_key is refused like a composite header", () => {
    const compiled = compileRequestBoundary(
      idempotentStep("order-${input.idempotency_key}"),
      "https://api.example.test",
    );
    expect(compiled.refusal).toBe("runtime_header");
  });

  test("a caller-bound idempotency_key is refused", () => {
    const compiled = compileRequestBoundary(
      idempotentStep("${caller.subject}", {
        boundary: {
          variables: { "caller.subject": { caller_bound: true } },
          max_body_bytes: 1024,
          max_calls: 1,
        },
      }),
      "https://api.example.test",
    );
    expect(compiled.refusal).toBe("runtime_header");
  });

  test("an explicit Idempotency-Key header wins and the unused step key is not reviewed", () => {
    const compiled = compileRequestBoundary(
      idempotentStep("order-${input.amount}", {
        headers: { "Idempotency-Key": "${input.idempotency_key}" },
      }),
      "https://api.example.test",
    );
    expect(compiled.refusal).toBeUndefined();
    expect(compiled.boundary?.idempotency_key).toEqual({ var: "input.idempotency_key" });
  });
});

test("an allowed-host destination reviews form fields and the step idempotency key", () => {
  const step = idempotentStep("${input.idempotency_key}", {
    connector_id: undefined,
    path: undefined,
    url: "${input.url}",
    boundary: {
      allowed_hosts: ["api.example.test"],
      variables: { "input.idempotency_key": { class: "identifier" } },
      max_body_bytes: 1024,
      max_calls: 1,
    },
  });
  const compiled = compileRequestBoundary(step, null);
  expect(compiled.refusal).toBeUndefined();
  expect(compiled.boundary?.destination).toEqual({
    var: "input.url",
    hosts: ["api.example.test"],
  });
  expect(compiled.boundary?.idempotency_key).toEqual({ var: "input.idempotency_key" });
});
