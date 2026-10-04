import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("parallel-fanout");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("49: Parallel step — concurrent branches, merged output, skipped in linear walk", () => {
  test("AC1+AC2+AC4: all branches run, status succeeded, output is per-branch array", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "parallel-enrich",
        slug: "parallel-enrich",
        steps: [
          {
            kind: "parallel",
            id: "enrich",
            branches: [["fetch_user_score"], ["fetch_risk_flag"]],
          },
          {
            kind: "transform",
            id: "fetch_user_score",
            expression: "return { score: 42 };",
          },
          {
            kind: "transform",
            id: "fetch_risk_flag",
            expression: "return { risk: false };",
          },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as {
      status: string;
      output: unknown;
      steps: Array<{ step_key: string; status: string }>;
    };

    expect(body.status).toBe("succeeded");

    const out = body.output as Array<Record<string, unknown>>;
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveProperty("fetch_user_score");
    expect(out[1]).toHaveProperty("fetch_risk_flag");
  });

  test("AC3: branch step IDs appear as skipped in linear walk", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "parallel-skip-check",
        slug: "parallel-skip-check",
        steps: [
          {
            kind: "parallel",
            id: "fan_out",
            branches: [["step_a"], ["step_b"]],
          },
          { kind: "transform", id: "step_a", expression: "return 1;" },
          { kind: "transform", id: "step_b", expression: "return 2;" },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const wf = (await createRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      steps: Array<{ step_key: string; status: string }>;
    };

    const stepA = runBody.steps.find((s) => s.step_key === "step_a");
    const stepB = runBody.steps.find((s) => s.step_key === "step_b");
    expect(stepA?.status).toBe("skipped");
    expect(stepB?.status).toBe("skipped");
  });
});
