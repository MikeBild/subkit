import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("branch_nested_skip");
});

afterAll(async () => {
  await ctx.cleanup();
});

const DRAFT = {
  name: "nested",
  steps: [
    {
      id: "probe",
      kind: "transform" as const,
      language: "javascript" as const,
      expression: "return { has: false, kind: '' };",
    },
    {
      id: "outer",
      kind: "branch" as const,
      when: "$scope.probe.data.has = true",
      then_steps: ["inner", "after"],
      else_steps: [],
    },
    {
      id: "inner",
      kind: "branch" as const,
      when: "$scope.probe.data.kind = 'unit'",
      then_steps: ["write_unit"],
      else_steps: ["write_other"],
    },
    {
      id: "write_unit",
      kind: "transform" as const,
      language: "javascript" as const,
      expression: "return { wrote: 'unit' };",
    },
    {
      id: "write_other",
      kind: "transform" as const,
      language: "javascript" as const,
      expression: "return { wrote: 'other' };",
    },
    {
      id: "after",
      kind: "transform" as const,
      language: "javascript" as const,
      expression: "return { done: true };",
    },
  ],
};

describe("nested branch inside an untaken arm", () => {
  test("skips the nested branch and both of its arms", async () => {
    const run = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "draft", definition: DRAFT },
      input: null,
    });
    expect(run.status).toBe("succeeded");
    const status = (key: string) => run.steps.find((s) => s.step_key === key)?.status;
    expect(status("inner")).toBe("skipped");
    expect(status("write_unit")).toBe("skipped");
    expect(status("write_other")).toBe("skipped");
    expect(status("after")).toBe("skipped");
  });
});
