import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let workflowId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("schema-validation");

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
    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: { amount: 500 } }),
    });
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
    expect(errBody.message).toMatch(/amount|currency/);
  });

  test("AC4: omitted input (no input field at all) → error, not an opaque later failure", async () => {
    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
    });
    expect(runRes.status).toBe(400);
    const errBody = (await runRes.json()) as { message: string };
    expect(errBody.message).toMatch(/amount|currency/);
  });
});
