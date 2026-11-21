import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("parallel_execution");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("parallel step", () => {
  test("every branch runs and the output holds one entry per branch in declared order", async () => {
    const run = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: {
        kind: "draft",
        definition: {
          name: "enrich",
          steps: [
            { kind: "parallel", id: "enrich", branches: [["score"], ["risk"]] },
            { kind: "transform", id: "score", expression: "return { score: 42 };" },
            { kind: "transform", id: "risk", expression: "return { risk: false };" },
          ],
        },
      },
      input: null,
    });
    expect(run.status).toBe("succeeded");
    const out = run.output as Array<Record<string, { data?: unknown }>>;
    expect(out).toHaveLength(2);
    expect(out[0]?.score?.data).toEqual({ score: 42 });
    expect(out[1]?.risk?.data).toEqual({ risk: false });
    expect(run.steps.find((s) => s.step_key === "score")?.status).toBe("skipped");
    expect(run.steps.find((s) => s.step_key === "risk")?.status).toBe("skipped");
  });
});
