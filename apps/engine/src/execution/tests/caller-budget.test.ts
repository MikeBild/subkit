import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { callerBudgetUnits, executions } from "../../db/schema/index.ts";
import { retryCatalogConflict } from "../../test-helpers/catalog-retry.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../../workflows/types.ts";
import { assertInputByteLimits, callerUsage, reserveCallerBudget } from "../caller-budget.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { settledOutcome } from "../core/status.ts";
import { runExecution } from "../engine.ts";
import { recoverExecutionPayload } from "../sensitive-payload.ts";
import { finalizeExecution } from "../state.ts";
import { callerBudgetFixtures, guardedDefinition } from "./caller-budget-fixtures.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

let roundWorkflow: string;

let roundDef: WorkflowDef;

let limitedWorkflow: string;

const { admit, productUser, unit } = callerBudgetFixtures({
  get ctx() {
    return ctx;
  },
  get roundWorkflow() {
    return roundWorkflow;
  },
});

function keepOpen(execution_id: string) {
  return finalizeExecution(
    ctx.testDb.db,
    ctx.tenantId,
    execution_id,
    { type: "completed" },
    { sensitive_result: { output: [{ type: "function_call" }] } },
  );
}

function usage(principal: ResolvedPrincipal, limit = 50, now = new Date(getTestNow())) {
  return ctx.testDb.db.transaction((tx) =>
    callerUsage(
      tx,
      {
        tenant_id: ctx.tenantId,
        bucket: "brain",
        principal_id: principal.id,
        limit,
        tz: "Europe/Berlin",
      },
      now,
    ),
  );
}

beforeAll(async () => {
  ctx = await createEngineCtx("caller-budget");
  roundDef = WorkflowDefSchema.parse(guardedDefinition(50));
  roundWorkflow = (await createWorkflowRow(ctx, roundDef)).workflow_id;
  limitedWorkflow = (await createWorkflowRow(ctx, guardedDefinition(3))).workflow_id;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe("workflow definition", () => {
  test("a caller guard requires a sensitive product user workflow with known billable steps", () => {
    const base = guardedDefinition(5) as Record<string, unknown>;
    expect(WorkflowDefSchema.safeParse({ ...base, product_id: undefined }).success).toBe(false);
    expect(WorkflowDefSchema.safeParse({ ...base, execution_privacy: undefined }).success).toBe(
      false,
    );
    expect(
      WorkflowDefSchema.safeParse(guardedDefinition(5, { billable_steps: ["missing"] })).success,
    ).toBe(false);
    expect(WorkflowDefSchema.safeParse(guardedDefinition(5, { tz: "Mars/Olympus" })).success).toBe(
      false,
    );
    expect(
      WorkflowDefSchema.safeParse(guardedDefinition(5, { max_metered: undefined })).success,
    ).toBe(false);
    expect(WorkflowDefSchema.safeParse(guardedDefinition(5, { round: "round" })).success).toBe(
      false,
    );
  });
});

describe("reservation at admission", () => {
  test("fifty turns are admitted and the fifty-first answers rate_limited with usage", async () => {
    const principal = await productUser();
    for (let turn = 0; turn < 50; turn += 1) {
      await admit(principal, { turn_id: `t-${turn}`, round: 1 });
    }
    await expect(admit(principal, { turn_id: "t-50", round: 1 })).rejects.toMatchObject({
      code: "rate_limited",
      details: { usage: { usedToday: 50, dailyLimit: 50 } },
    });
    expect(await unit(principal, "t-50")).toBeUndefined();
  });

  test("later rounds of a reserved turn extend the lease without charging", async () => {
    const principal = await productUser();
    await keepOpen((await admit(principal, { turn_id: "turn", round: 1 })).execution_id);
    for (let round = 2; round <= 6; round += 1) {
      await keepOpen((await admit(principal, { turn_id: "turn", round })).execution_id);
    }
    expect((await usage(principal)).usedToday).toBe(1);
    expect(await unit(principal, "turn")).toMatchObject({ state: "reserved" });
  });

  test("a round while the previous round is still queued answers turn_busy", async () => {
    const principal = await productUser();
    await admit(principal, { turn_id: "queued", round: 1 });
    await expect(admit(principal, { turn_id: "queued", round: 2 })).rejects.toMatchObject({
      code: "turn_busy",
    });
    await expect(admit(principal, { turn_id: "queued", round: 1 })).rejects.toMatchObject({
      code: "turn_busy",
    });
    expect((await usage(principal)).usedToday).toBe(1);
  });

  test("concurrent rounds of one turn admit exactly one", async () => {
    const principal = await productUser();
    await keepOpen((await admit(principal, { turn_id: "flood", round: 1 })).execution_id);
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () =>
        retryCatalogConflict(() => admit(principal, { turn_id: "flood", round: 2 })),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "turn_busy" });
    }
    const active = await ctx.testDb.db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenantId),
          eq(executions.guard_unit_key, `${principal.id}/flood`),
          eq(executions.status, "queued"),
        ),
      );
    expect(active).toHaveLength(1);
  });

  test("a call whose cancel was requested no longer blocks the next call of its turn", async () => {
    const principal = await productUser();
    const first = await admit(principal, { turn_id: "cancelled", round: 1 });
    await ctx.testDb.db
      .update(executions)
      .set({ abort_requested_at: new Date(getTestNow()) })
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, first.execution_id)));
    await admit(principal, { turn_id: "cancelled", round: 1 });
    expect((await usage(principal)).usedToday).toBe(1);
  });

  test("a committed turn admits later calls without a charge until max_metered", async () => {
    const principal = await productUser();
    const admitted = await admit(principal, { turn_id: "done", round: 1 });
    await finalizeExecution(
      ctx.testDb.db,
      ctx.tenantId,
      admitted.execution_id,
      { type: "completed" },
      { sensitive_result: { output: [{ type: "message" }] } },
    );
    expect((await unit(principal, "done"))?.state).toBe("committed");
    await keepOpen((await admit(principal, { turn_id: "done", round: 1 })).execution_id);
    expect((await unit(principal, "done"))?.state).toBe("committed");
    expect((await usage(principal)).usedToday).toBe(1);
    await ctx.testDb.db
      .update(callerBudgetUnits)
      .set({ metered: 3 })
      .where(
        and(
          eq(callerBudgetUnits.tenant_id, ctx.tenantId),
          eq(callerBudgetUnits.principal_id, principal.id),
        ),
      );
    await expect(admit(principal, { turn_id: "done", round: 1 })).rejects.toMatchObject({
      code: "turn_limit",
    });
  });

  test("a turn that used its metered calls answers turn_limit", async () => {
    const principal = await productUser();
    await keepOpen((await admit(principal, { turn_id: "busy", round: 1 })).execution_id);
    await ctx.testDb.db
      .update(callerBudgetUnits)
      .set({ metered: 3 })
      .where(
        and(
          eq(callerBudgetUnits.tenant_id, ctx.tenantId),
          eq(callerBudgetUnits.principal_id, principal.id),
        ),
      );
    await expect(admit(principal, { turn_id: "busy", round: 2 })).rejects.toMatchObject({
      code: "turn_limit",
    });
  });

  test("concurrent turns of one caller at limit minus one admit exactly one", async () => {
    const principal = await productUser();
    await admit(principal, { turn_id: "first", round: 1 }, limitedWorkflow);
    await admit(principal, { turn_id: "second", round: 1 }, limitedWorkflow);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        retryCatalogConflict(() =>
          admit(principal, { turn_id: `race-${index}`, round: 1 }, limitedWorkflow),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "rate_limited" });
    }
    expect((await usage(principal, 3)).usedToday).toBe(3);
  });

  test("a replayed idempotency key never charges", async () => {
    const principal = await productUser();
    const first = await admit(principal, { turn_id: "replay", round: 1 }, roundWorkflow, "k-1");
    await finalizeExecution(
      ctx.testDb.db,
      ctx.tenantId,
      first.execution_id,
      { type: "completed" },
      { sensitive_result: { output: [{ type: "message" }] } },
    );
    const again = await admit(principal, { turn_id: "replay", round: 1 }, roundWorkflow, "k-1");
    expect(again.replayed).toBe(true);
    expect((await usage(principal)).usedToday).toBe(1);
  });

  test("an input part above its byte limit answers invalid and reserves nothing", async () => {
    const principal = await productUser();
    await expect(
      admit(principal, { turn_id: "big", round: 1, request: { text: "x".repeat(80) } }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await unit(principal, "big")).toBeUndefined();
  });

  test("the same unit key of another principal is charged to that principal", async () => {
    const owner = await productUser();
    const other = await productUser();
    await admit(owner, { turn_id: "shared", round: 1 });
    await admit(other, { turn_id: "shared", round: 2 });
    expect((await usage(owner)).usedToday).toBe(1);
    expect((await usage(other)).usedToday).toBe(1);
  });
});

describe("settlement when the run ends", () => {
  async function end(execution_id: string, status: "failed" | "aborted" | "timed_out") {
    await finalizeExecution(ctx.testDb.db, ctx.tenantId, execution_id, settledOutcome(status), {
      failure: { step_id: null, error_code: status, error_message: status },
    });
  }

  for (const status of ["failed", "aborted", "timed_out"] as const) {
    test(`a ${status} run without a billable step is refunded`, async () => {
      const principal = await productUser();
      const admitted = await admit(principal, { turn_id: `refund-${status}`, round: 1 });
      await end(admitted.execution_id, status);
      expect((await unit(principal, `refund-${status}`))?.state).toBe("refunded");
      expect((await usage(principal)).usedToday).toBe(0);
    });
  }

  test("a failure after the billable step succeeded stays charged", async () => {
    const principal = await productUser();
    const admitted = await admit(principal, { turn_id: "paid", round: 1 });
    await ctx.testDb.db
      .update(callerBudgetUnits)
      .set({ billable: true })
      .where(
        and(
          eq(callerBudgetUnits.tenant_id, ctx.tenantId),
          eq(callerBudgetUnits.principal_id, principal.id),
        ),
      );
    await end(admitted.execution_id, "failed");
    expect((await unit(principal, "paid"))?.state).toBe("reserved");
    expect((await usage(principal)).usedToday).toBe(1);
  });

  test("a refund waits while another run of the same turn is active", async () => {
    const principal = await productUser();
    const first = await admit(principal, { turn_id: "twin", round: 1 });
    await ctx.testDb.db.insert(executions).values({
      tenant_id: ctx.tenantId,
      status: "running",
      request_source: "api",
      execution_mode: "dev",
      caller_origin: "principal",
      caller_context: callerFromPrincipal(principal, ctx.tenantId, "testapp"),
      guard_bucket: "brain",
      guard_unit_key: `${principal.id}/twin`,
    });
    await end(first.execution_id, "failed");
    expect((await unit(principal, "twin"))?.state).toBe("reserved");
  });

  test("an expired lease commits billable units and refunds the rest", async () => {
    const principal = await productUser();
    await ctx.testDb.db.transaction(async (tx) => {
      await reserveCallerBudget(
        tx,
        roundDef,
        callerFromPrincipal(principal, ctx.tenantId, "testapp"),
        {
          turn_id: "lease-paid",
          round: 1,
        },
      );
      await reserveCallerBudget(
        tx,
        roundDef,
        callerFromPrincipal(principal, ctx.tenantId, "testapp"),
        {
          turn_id: "lease-free",
          round: 1,
        },
      );
    });
    await ctx.testDb.db
      .update(callerBudgetUnits)
      .set({ billable: true })
      .where(
        and(
          eq(callerBudgetUnits.tenant_id, ctx.tenantId),
          eq(callerBudgetUnits.principal_id, principal.id),
          eq(callerBudgetUnits.unit_key, "lease-paid"),
        ),
      );
    const later = new Date(getTestNow() + 11 * 60_000);
    expect((await usage(principal, 50, later)).usedToday).toBe(1);
    expect((await unit(principal, "lease-paid"))?.state).toBe("committed");
    expect((await unit(principal, "lease-free"))?.state).toBe("refunded");
  });

  test("a completed run commits its turn and returns usage in the result", async () => {
    const principal = await productUser();
    const admitted = await admit(principal, { turn_id: "full", round: 1, final: true });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: roundWorkflow },
      input: admitted.input,
      options: { existing_execution_id: admitted.execution_id, principal, hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    const stored = await unit(principal, "full");
    expect(stored).toMatchObject({ state: "committed", billable: true, metered: 1 });
    const [row] = await ctx.testDb.db
      .select({ sensitive_result: executions.sensitive_result })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, admitted.execution_id)));
    expect(
      recoverExecutionPayload(row?.sensitive_result, ctx.tenantId, admitted.execution_id, "result"),
    ).toEqual({
      output: [{ type: "message" }],
      usage: { usedToday: 1, dailyLimit: 50 },
    });
  });

  test("a tool round keeps the turn reserved for the next round", async () => {
    const principal = await productUser();
    const admitted = await admit(principal, { turn_id: "tools", round: 1 });
    await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: roundWorkflow },
      input: admitted.input,
      options: { existing_execution_id: admitted.execution_id, principal, hold_writes: true },
    });
    expect(await unit(principal, "tools")).toMatchObject({ state: "reserved", billable: true });
    await admit(principal, { turn_id: "tools", round: 2 });
    expect((await usage(principal)).usedToday).toBe(1);
  });
});

describe("local day in the configured time zone", () => {
  async function reserveAt(principal: ResolvedPrincipal, turn: string, at: string) {
    return ctx.testDb.db.transaction((tx) =>
      reserveCallerBudget(
        tx,
        roundDef,
        callerFromPrincipal(principal, ctx.tenantId, "testapp"),
        { turn_id: turn, round: 1 },
        new Date(at),
      ),
    );
  }

  test("Berlin midnight starts a new day", async () => {
    const principal = await productUser();
    await reserveAt(principal, "late", "2026-07-14T21:59:00.000Z");
    expect((await unit(principal, "late"))?.day).toBe("2026-07-14");
    await reserveAt(principal, "early", "2026-07-14T22:01:00.000Z");
    expect((await unit(principal, "early"))?.day).toBe("2026-07-15");
    const before = await usage(principal, 50, new Date("2026-07-14T21:59:30.000Z"));
    expect(before).toMatchObject({ usedToday: 1, day: "2026-07-14" });
    expect(before.resetsAt).toBe("2026-07-14T22:00:00.000Z");
  });

  test("the day of the autumn clock change lasts twenty-five hours", async () => {
    const principal = await productUser();
    const during = await usage(principal, 50, new Date("2026-10-24T22:30:00.000Z"));
    expect(during.day).toBe("2026-10-25");
    expect(during.resetsAt).toBe("2026-10-25T23:00:00.000Z");
    const spring = await usage(principal, 50, new Date("2026-03-28T23:30:00.000Z"));
    expect(spring.day).toBe("2026-03-29");
    expect(spring.resetsAt).toBe("2026-03-29T22:00:00.000Z");
  });
});

describe("input byte limits", () => {
  const def = WorkflowDefSchema.parse({
    ...guardedDefinition(5),
    execution_guards: { input_bytes: { "request.instructions": 32768, "request.input": 64 } },
  });

  test("a string counts its own UTF-8 bytes, newlines and quotes included", () => {
    const text = `${"line\n".repeat(6553)}ab"`;
    expect(Buffer.byteLength(text)).toBe(32768);
    expect(() => assertInputByteLimits(def, { request: { instructions: text } })).not.toThrow();
    expect(() => assertInputByteLimits(def, { request: { instructions: `${text}x` } })).toThrow(
      "exceeds 32768 bytes",
    );
    expect(() =>
      assertInputByteLimits(def, { request: { instructions: "ü".repeat(16_385) } }),
    ).toThrow();
  });

  test("an array counts its JSON text", () => {
    const items = [{ text: "x".repeat(40) }];
    expect(JSON.stringify(items).length).toBeLessThanOrEqual(64);
    expect(() => assertInputByteLimits(def, { request: { input: items } })).not.toThrow();
    expect(() =>
      assertInputByteLimits(def, { request: { input: [...items, { text: "y" }] } }),
    ).toThrow();
  });
});
