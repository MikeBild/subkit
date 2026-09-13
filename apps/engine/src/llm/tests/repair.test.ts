import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runRepairFlow } from "../flows/repair.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("repair");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/flows/repair", () => {
  test("proposes a safe patch for a simple field rename drift", async () => {
    const drift = [
      "- path: $.data.id",
      "+ path: $.data.result.id",
      "renamed wrapper object to `result`",
    ].join("\n");
    const out = await runRepairFlow(
      {
        tenant_id: ctx.tenant_id,
        execution_id: "exec-test-1",
        failing_step: {
          id: "step-1",
          request: { method: "GET", url: "/users/1" },
          response: { data: { result: { id: 1, name: "Ada" } } },
        },
        drift_diff: drift,
        connector_id: ctx.connector_id,
      },
      ctx.testDb.db,
    );

    expect(out.patch_proposal).toBeTruthy();
    expect(out.patch_proposal.classification).toBe("safe");
    expect(out.patch_proposal.description.length).toBeGreaterThan(0);
    expect(out.included_skill_ids.length).toBeGreaterThan(0);
  });
});
