import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runGenerateFlow } from "../flows/generate.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("generate");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/flows/generate", () => {
  test("produces a draft workflow grounded in skills", async () => {
    const out = await runGenerateFlow(
      {
        tenant_id: ctx.tenant_id,
        description: "list users from the api",
        connector_id: ctx.connector_id,
      },
      ctx.testDb.db,
    );

    expect(out.draft_workflow).toBeTruthy();
    const steps = (out.draft_workflow.steps as Array<{ kind?: string }> | undefined) ?? [];
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThanOrEqual(1);
    const requestStep = steps.find((s) => s?.kind === "request");
    expect(requestStep).toBeDefined();

    expect(out.included_skill_ids.length).toBeGreaterThan(0);
    expect(out.model_used).toBeTruthy();
  });
});
