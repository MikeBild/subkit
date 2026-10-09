import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { createEngineCtx, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("branch_fixture_replay");
});

afterAll(async () => {
  await ctx.cleanup();
});

const DRAFT = {
  name: "routed",
  steps: [
    {
      id: "probe",
      kind: "transform" as const,
      language: "javascript" as const,
      expression: "return { flag: true };",
    },
    {
      id: "route",
      kind: "branch" as const,
      when: "$scope.probe.data.flag",
      then_steps: ["taken"],
      else_steps: ["untaken"],
    },
    {
      id: "taken",
      kind: "transform" as const,
      language: "javascript" as const,
      expression: 'return { picked: "then" };',
    },
    {
      id: "untaken",
      kind: "transform" as const,
      language: "javascript" as const,
      expression: 'return { picked: "else" };',
    },
  ],
};

const envelope = (data: unknown) => ({ data, duration_ms: 0, error: null });

function statusOf(run: Awaited<ReturnType<typeof runExecution>>, key: string) {
  return run.steps.find((s) => s.step_key === key)?.status;
}

describe("branch step replayed from a fixture", () => {
  test("the live run leaves the untaken arm skipped and the taken arm's output as the final value", async () => {
    const live = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "draft", definition: DRAFT },
      input: null,
    });
    expect(live.status).toBe("succeeded");
    expect(statusOf(live, "taken")).toBe("succeeded");
    expect(statusOf(live, "untaken")).toBe("skipped");
    expect(live.output).toEqual({ picked: "then" });
  });

  test("a replayed branch fixture still steers control flow: the recorded arm's sibling stays skipped", async () => {
    const replayed = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "draft", definition: DRAFT },
      input: null,
      options: {
        step_output_fixtures: {
          probe: envelope({ flag: true }),
          route: envelope({ matched: true, arm: "then" }),
          taken: envelope({ picked: "then", replayed: true }),
        },
      },
    });
    expect(replayed.status).toBe("succeeded");
    expect(statusOf(replayed, "route")).toBe("succeeded");
    expect(statusOf(replayed, "taken")).toBe("succeeded");
    expect(statusOf(replayed, "untaken")).toBe("skipped");
    expect(replayed.output).toEqual({ picked: "then", replayed: true });
  });

  test("a fixture recording the other arm skips the arm the live predicate would have taken", async () => {
    const replayed = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "draft", definition: DRAFT },
      input: null,
      options: {
        step_output_fixtures: {
          probe: envelope({ flag: true }),
          route: envelope({ matched: false, arm: "else" }),
        },
      },
    });
    expect(replayed.status).toBe("succeeded");
    expect(statusOf(replayed, "taken")).toBe("skipped");
    expect(statusOf(replayed, "untaken")).toBe("succeeded");
    expect(replayed.output).toEqual({ picked: "else" });
  });
});
