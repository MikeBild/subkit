// Execution state-integrity regressions (E3).
//
// Pins three contracts the external review flagged:
//   #14 finalizeExecution is compare-and-set — a terminal row is never
//       overwritten by a later completion/cancel/timeout.
//   #13 the queued-only finalize (used by queued-cancel) refuses to touch
//       a row that already moved to running.
//   #15 an input-schema violation strands NO execution row (validation now
//       runs before the row is created).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { auditLog, executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { runExecution } from "./engine.ts";
import {
  createExecution,
  finalizeExecution,
  finalizeStepRow,
  insertStepRow,
  markExecutionRunning,
  requestExecutionAbort,
} from "./state.ts";

let testDb: TestDb;
let db: Db;
let tenantId = "";

beforeAll(async () => {
  testDb = await createTestDb("execution-state");
  db = testDb.db;
  const [t] = await db
    .insert(tenants)
    .values({ slug: "exec-state", display_name: "Exec State" })
    .returning();
  tenantId = t!.id;
});

afterAll(async () => {
  if (testDb) await testDb.cleanup();
});

async function newQueued(): Promise<string> {
  return createExecution(db, {
    tenant_id: tenantId,
    workflow_id: null,
    workflow_version_id: null,
    source_kind: "draft",
    source_ref: null,
    request_source: "api",
  });
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.select().from(executions).where(eq(executions.id, id));
  return row?.status ?? "";
}

describe("finalizeExecution — compare-and-set (#14)", () => {
  test("a terminal row is not overwritten by a later finalize", async () => {
    const id = await newQueued();
    await finalizeExecution(db, tenantId, id, "succeeded", null);
    expect(await statusOf(id)).toBe("succeeded");

    // A racing cancel/timeout must NOT clobber the recorded success.
    await finalizeExecution(db, tenantId, id, "failed", null);
    expect(await statusOf(id)).toBe("succeeded");
  });
});

describe("finalizeStepRow — compare-and-set", () => {
  test("a late worker cannot overwrite a step terminalized by recovery", async () => {
    const executionId = await newQueued();
    await markExecutionRunning(db, tenantId, executionId, new Date(FROZEN_NOW));
    const stepId = await insertStepRow(db, {
      tenant_id: tenantId,
      execution_id: executionId,
      step_key: "stuck",
      step_index: 0,
      kind: "transform",
    });
    await db
      .update(executionSteps)
      .set({ status: "timed_out", finished_at: new Date(FROZEN_NOW) })
      .where(eq(executionSteps.id, stepId));

    await finalizeStepRow(
      db,
      stepId,
      "succeeded",
      { status: "succeeded", output: { late: true }, retry_count: 0, duration_ms: 1 },
      { output_preview: { late: true }, result_preview: null, result_storage_uri: null },
    );

    const [step] = await db.select().from(executionSteps).where(eq(executionSteps.id, stepId));
    expect(step?.status).toBe("timed_out");
    expect(step?.output_preview).toBeNull();
  });
});

describe("a refused dispatch reaches the audit trail", () => {
  // Ninety-eight dispatches had been refused on one installation — requests to
  // an address the approval did not cover — and `audit_log` held not one row
  // about any of them. The trail recorded what ran and never what was stopped,
  // so the one question governance exists to answer, "did the limit hold?",
  // could only be answered by reading execution rows by hand.
  async function refuse(code: string | null, message = "outside the boundary") {
    const executionId = await newQueued();
    await markExecutionRunning(db, tenantId, executionId, new Date(FROZEN_NOW));
    const stepId = await insertStepRow(db, {
      tenant_id: tenantId,
      execution_id: executionId,
      step_key: "send",
      step_index: 2,
      kind: "request",
    });
    await finalizeStepRow(
      db,
      stepId,
      "failed",
      {
        status: "failed",
        retry_count: 0,
        duration_ms: 3,
        ...(code ? { error: { code, message } } : {}),
      },
      { output_preview: null, result_preview: null, result_storage_uri: null },
    );
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, executionId)));
  }

  test("the refusal is recorded with the step and the reason", async () => {
    const rows = await refuse("request_outside_declared_boundary");
    const entry = rows.find((row) => row.action === "execution.boundary_refused");
    expect(entry).toBeDefined();
    expect(entry?.result).toBe("denied");
    expect(entry?.reason).toBe("request_outside_declared_boundary");
    expect((entry?.metadata as { step_key?: string })?.step_key).toBe("send");
    expect((entry?.metadata as { detail?: string })?.detail).toContain("outside the boundary");
  });

  test("the real refusal code is what the runtime reports, not a blanket one", async () => {
    // This file can only assert the SINK. It hands `finalizeStepRow` a code by
    // hand, so it is structurally blind to the hop that broke this: the request
    // dispatcher rewrote every governance refusal to `authority_invalid` before
    // the step row existed, and that code is not in the set, so nothing was
    // written. Three of the four codes this suite "covered" could never arrive.
    //
    // The end-to-end proof lives in
    // `execution/tests/authority-admission.integration.test.ts` and
    // `authority-runtime.integration.test.ts`, which drive the real dispatcher.
    // What belongs HERE is the other half: every code the runtime can now
    // report does reach the trail.
    for (const code of [
      "execution_authority_changed",
      "execution_authority_unavailable",
      "execution_authority_required",
      "authority_redirect_denied",
    ]) {
      const rows = await refuse(code);
      const entry = rows.find((row) => row.action === "execution.boundary_refused");
      expect(entry, `no governance row for ${code}`).toBeDefined();
      expect(entry?.reason).toBe(code);
    }
  });

  test("a code nothing produces is not kept as a promise", async () => {
    // `execution_boundary_exhausted` sat in the set with no producer anywhere —
    // a guard over a case that could not happen, which reads like coverage.
    const rows = await refuse("execution_boundary_exhausted");
    expect(rows.some((row) => row.action === "execution.boundary_refused")).toBe(false);
  });

  test("an ordinary failure is not a governance event", async () => {
    // A catch-all would bury the refusals among timeouts and 404s, and the
    // trail exists to separate exactly those two things.
    for (const code of ["http_4xx", null]) {
      const rows = await refuse(code);
      expect(rows.some((row) => row.action === "execution.boundary_refused")).toBe(false);
    }
  });
});

describe("finalizeExecution — queued-only guard (#13)", () => {
  test("queued → aborted succeeds", async () => {
    const id = await newQueued();
    await finalizeExecution(db, tenantId, id, "aborted", null, null, ["queued"]);
    expect(await statusOf(id)).toBe("aborted");
  });

  test("a running row is left untouched by the queued-only finalize", async () => {
    const id = await newQueued();
    await markExecutionRunning(db, tenantId, id, new Date(FROZEN_NOW));
    await finalizeExecution(db, tenantId, id, "aborted", null, null, ["queued"]);
    // Still running — the queued-cancel path must not abort a row that a
    // concurrent worker already picked up; the abort signal handles that.
    expect(await statusOf(id)).toBe("running");
  });

  test("a durable abort request prevents queued → running", async () => {
    const id = await newQueued();
    await requestExecutionAbort(db, {
      tenant_id: tenantId,
      execution_id: id,
      actor_type: "user",
      actor_id: null,
      request_source: "api",
    });
    const started = await markExecutionRunning(db, tenantId, id, new Date(FROZEN_NOW));
    expect(started).toBe(false);
    expect(await statusOf(id)).toBe("queued");
  });

  test("a worker that loses the queued → running race performs no run side effects", async () => {
    const id = await newQueued();
    await requestExecutionAbort(db, {
      tenant_id: tenantId,
      execution_id: id,
      actor_type: "user",
      actor_id: null,
      request_source: "api",
    });
    await finalizeExecution(db, tenantId, id, "aborted", null, null, ["queued"]);

    const result = await runExecution({
      db,
      tenant_id: tenantId,
      source: {
        kind: "draft",
        definition: {
          name: "must-not-start",
          steps: [{ id: "must-not-run", kind: "transform", expression: "$input" }],
        },
      },
      input: { unsafe: true },
      options: { existing_execution_id: id },
    });

    expect(result.status).toBe("aborted");
    expect(result.steps).toEqual([]);
    expect(await statusOf(id)).toBe("aborted");
    const steps = await db
      .select()
      .from(executionSteps)
      .where(and(eq(executionSteps.tenant_id, tenantId), eq(executionSteps.execution_id, id)));
    expect(steps).toEqual([]);
    const startedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.resource_id, id),
          eq(auditLog.action, "execution.started"),
        ),
      );
    expect(startedAudits).toEqual([]);
  });
});

describe("runExecution — input validation (#15)", () => {
  test("an input-schema violation strands no execution row", async () => {
    const before = await db.select().from(executions).where(eq(executions.tenant_id, tenantId));
    await expect(
      runExecution({
        db,
        tenant_id: tenantId,
        source: {
          kind: "draft",
          definition: {
            name: "needs-input",
            input_schema: {
              type: "object",
              required: ["x"],
              properties: { x: { type: "string" } },
            },
            steps: [{ id: "noop", kind: "transform", expression: "$input" }],
          },
        },
        input: {},
      }),
    ).rejects.toThrow();
    const after = await db.select().from(executions).where(eq(executions.tenant_id, tenantId));
    // No new row was created — validation runs before createExecution.
    expect(after.length).toBe(before.length);
  });
});
