// User story: As an operator, I want branch steps to route execution to the
// correct arm and skip the other arm's steps, so that workflows can handle
// conditional logic without running both paths.
//
// Acceptance criteria:
//   - AC1: When the branch `when` condition is true, `then_steps` run and
//          `else_steps` are skipped (appear as "aborted" in step summaries).
//   - AC2: When the `when` condition is false, `else_steps` run and
//          `then_steps` are skipped.
//   - AC3: Workflow status is "succeeded" in both cases — branch itself
//          doesn't fail just because an arm is not taken.
// Spec refs: plan docs — §2d BRANCH STEP: Actual Control Flow

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("branch-workflow");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
});

describe("46: Branch workflow — correct arm runs, other arm skipped", () => {
  test("AC1+AC3: true branch runs then_steps, else_steps are skipped, status succeeded", async () => {
    // Create workflow: prepare step outputs status "approved", branch checks it.
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "branch-approved",
        slug: "branch-approved",
        steps: [
          {
            kind: "transform",
            id: "prepare",
            expression: "{ 'status': 'approved' }",
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
            expression: "'payment_accepted'",
          },
          {
            kind: "transform",
            id: "handle_rejected",
            expression: "'payment_denied'",
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
    expect(rejectedStep?.status).toBe("aborted");
    expect(rejectedStep?.error?.code).toBe("skipped");
  });

  test("AC2+AC3: false branch skips then_steps, else_steps run, status succeeded", async () => {
    // Condition evaluates to false (status is "pending", not "approved").
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "branch-rejected",
        slug: "branch-rejected",
        steps: [
          {
            kind: "transform",
            id: "prepare",
            expression: "{ 'status': 'pending' }",
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
            expression: "'payment_accepted'",
          },
          {
            kind: "transform",
            id: "handle_rejected",
            expression: "'payment_denied'",
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
    expect(approvedStep?.status).toBe("aborted");
    expect(approvedStep?.error?.code).toBe("skipped");

    const rejectedStep = body.steps.find((s) => s.step_key === "handle_rejected");
    expect(rejectedStep?.status).toBe("succeeded");
  });
});
