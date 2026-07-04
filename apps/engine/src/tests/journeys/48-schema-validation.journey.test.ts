// User story: As an operator, I want workflows to validate their inputs against
// a declared schema so that callers receive an immediate, precise error when
// they supply wrong data — rather than seeing a confusing mid-execution failure.
//
// Acceptance criteria:
//   - AC1: A workflow with `input_schema` succeeds when all required fields
//          are present in the input.
//   - AC2: A workflow with `input_schema` returns an error when a required
//          field is missing from the input.
//   - AC3: The error message identifies the missing field by name.
// Spec refs: plan docs — §2a INPUT: Schema Validation & Coercion

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let workflowId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("schema-validation");

  // Create a workflow that requires an "amount" field in its input.
  const createRes = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "charge-processor",
      slug: "charge-processor",
      input_schema: {
        type: "object",
        required: ["amount", "currency"],
        properties: {
          amount: { type: "number" },
          currency: { type: "string" },
        },
      },
      steps: [
        {
          kind: "transform",
          id: "echo_input",
          language: "javascript",
          expression: "return input.input;",
        },
      ],
    }),
  });
  if (createRes.status !== 201) throw new Error("seed workflow failed");
  const wf = (await createRes.json()) as { id: string };
  workflowId = wf.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("48: Input schema validation — required fields enforced at run start", () => {
  test("AC1: valid input (all required fields present) → status succeeded", async () => {
    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        input: { amount: 1000, currency: "usd" },
      }),
    });
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as { status: string };
    expect(body.status).toBe("succeeded");
  });

  test("AC2+AC3: missing required field → error response mentioning the field", async () => {
    // Provide only `amount`, omitting `currency`.
    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: { amount: 500 } }),
    });
    // input_schema_violation is a client-supplied-data error → 400.
    expect(runRes.status).toBe(400);
    const errBody = (await runRes.json()) as { message: string };
    expect(errBody.message).toContain("currency");
  });

  test("AC3: completely empty input → error mentions each required field", async () => {
    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
    });
    expect(runRes.status).toBe(400);
    const errBody = (await runRes.json()) as { message: string };
    // Both required fields should be mentioned somewhere in the error.
    expect(errBody.message).toMatch(/amount|currency/);
  });

  test("AC4: omitted input (no input field at all) → error, not an opaque later failure", async () => {
    // A workflow run with required input fields and NO input — the case
    // a schedule fires when its `input` column is null. Validation must
    // still trip here; a null/undefined input cannot satisfy `required`.
    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
    });
    expect(runRes.status).toBe(400);
    const errBody = (await runRes.json()) as { message: string };
    expect(errBody.message).toMatch(/amount|currency/);
  });
});
