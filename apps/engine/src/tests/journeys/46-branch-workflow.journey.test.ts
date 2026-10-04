import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("branch-workflow");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("46: Branch workflow — correct arm runs, other arm skipped", () => {
  test("AC1+AC3: true branch runs then_steps, else_steps are skipped, status succeeded", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "branch-approved",
        slug: "branch-approved",
        steps: [
          {
            kind: "transform",
            id: "prepare",
            language: "javascript",
            expression: "return { status: 'approved' };",
          },
          {
            kind: "branch",
            id: "check_status",
            when: "prepare.data.status = 'approved'",
            then_steps: ["handle_approved"],
            else_steps: ["handle_rejected"],
          },
          {
            kind: "transform",
            id: "handle_approved",
            language: "javascript",
            expression: "return 'payment_accepted';",
          },
          {
            kind: "transform",
            id: "handle_rejected",
            language: "javascript",
            expression: "return 'payment_denied';",
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
      steps: Array<{ step_key: string; status: string; error?: { code: string } }>;
    };

    expect(body.status).toBe("succeeded");

    const approvedStep = body.steps.find((s) => s.step_key === "handle_approved");
    expect(approvedStep?.status).toBe("succeeded");

    const rejectedStep = body.steps.find((s) => s.step_key === "handle_rejected");
    expect(rejectedStep?.status).toBe("skipped");
    expect(rejectedStep?.error?.code).toBe("skipped");
  });

  test("AC2+AC3: false branch skips then_steps, else_steps run, status succeeded", async () => {
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "branch-rejected",
        slug: "branch-rejected",
        steps: [
          {
            kind: "transform",
            id: "prepare",
            language: "javascript",
            expression: "return { status: 'pending' };",
          },
          {
            kind: "branch",
            id: "check_status",
            when: "prepare.data.status = 'approved'",
            then_steps: ["handle_approved"],
            else_steps: ["handle_rejected"],
          },
          {
            kind: "transform",
            id: "handle_approved",
            language: "javascript",
            expression: "return 'payment_accepted';",
          },
          {
            kind: "transform",
            id: "handle_rejected",
            language: "javascript",
            expression: "return 'payment_denied';",
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
      steps: Array<{ step_key: string; status: string; error?: { code: string } }>;
    };

    expect(body.status).toBe("succeeded");

    const approvedStep = body.steps.find((s) => s.step_key === "handle_approved");
    expect(approvedStep?.status).toBe("skipped");
    expect(approvedStep?.error?.code).toBe("skipped");

    const rejectedStep = body.steps.find((s) => s.step_key === "handle_rejected");
    expect(rejectedStep?.status).toBe("succeeded");
  });
});
