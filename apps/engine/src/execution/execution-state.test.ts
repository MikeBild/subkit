import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { auditLog, executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { withContext } from "../logging/context.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import type { CallerContext } from "./caller-context.ts";
import { runExecution } from "./engine.ts";
import {
  createExecution,
  finalizeExecution,
  finalizeStepRow,
  insertStepRow,
  markExecutionRunning,
  requestExecutionAbort,
} from "./state.ts";
import type { RequestSource } from "./types.ts";

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

async function newQueued(
  caller_context: CallerContext | null = null,
  request_source: RequestSource = "api",
): Promise<string> {
  return createExecution(db, {
    tenant_id: tenantId,
    workflow_id: null,
    workflow_version_id: null,
    source_kind: "draft",
    source_ref: null,
    request_source,
    caller_context,
    caller_origin: caller_context ? "principal" : "unknown",
  });
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.select().from(executions).where(eq(executions.id, id));
  return row?.status ?? "";
}

describe("finalizeExecution — compare-and-set", () => {
  test("a terminal row is not overwritten by a later finalize", async () => {
    const id = await newQueued();
    await finalizeExecution(db, tenantId, id, "succeeded", null);
    expect(await statusOf(id)).toBe("succeeded");

    await finalizeExecution(db, tenantId, id, "failed", null);
    expect(await statusOf(id)).toBe("succeeded");
  });
});

describe("execution audit provenance", () => {
  test("persists trusted context independently from declared request source", async () => {
    const id = await withContext(
      { audit_origin_source: "ui", audit_trace_id: "server-trace-execution" },
      () => newQueued(null, "cli"),
    );
    const [row] = await db
      .select({
        origin_source: executions.origin_source,
        audit_trace_id: executions.audit_trace_id,
        request_source: executions.request_source,
      })
      .from(executions)
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, id)));
    expect(row).toEqual({
      origin_source: "ui",
      audit_trace_id: "server-trace-execution",
      request_source: "cli",
    });
  });

  test("leaves provenance unknown without a trusted context", async () => {
    const id = await newQueued();
    const [row] = await db
      .select({
        origin_source: executions.origin_source,
        audit_trace_id: executions.audit_trace_id,
      })
      .from(executions)
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, id)));
    expect(row).toEqual({ origin_source: null, audit_trace_id: null });
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
      {
        tenant_id: tenantId,
        output_preview: { late: true },
        result_preview: null,
        result_storage_uri: null,
      },
    );

    const [step] = await db.select().from(executionSteps).where(eq(executionSteps.id, stepId));
    expect(step?.status).toBe("timed_out");
    expect(step?.output_preview).toBeNull();
  });
});

describe("a refused dispatch reaches the audit trail", () => {
  async function refuse(
    code: string | null,
    message = "outside the boundary",
    caller_context: CallerContext | null = null,
    request_source: RequestSource = "api",
  ) {
    const executionId = await newQueued(caller_context, request_source);
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
      { tenant_id: tenantId, output_preview: null, result_preview: null, result_storage_uri: null },
    );
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, executionId)));
  }

  test("an API execution without historical caller context remains unknown", async () => {
    const executionId = await newQueued(null, "api");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "execution.queued"),
          eq(auditLog.resource_id, executionId),
        ),
      );
    expect(entry?.actor_type).toBe("unknown");
    expect(entry?.actor_id).toBeNull();
    expect((entry?.metadata as { request_source?: string })?.request_source).toBe("api");
  });

  test("the refusal is recorded with the step and the reason", async () => {
    const caller: CallerContext = {
      tenantId,
      principalId: "00000000-0000-4000-8000-000000000001",
      principalKind: "user",
      provider: "api_key",
      productId: null,
    };
    const rows = await refuse(
      "request_outside_declared_boundary",
      "outside the boundary",
      caller,
      "mcp",
    );
    const entry = rows.find((row) => row.action === "execution.boundary_refused");
    expect(entry).toBeDefined();
    expect(entry?.actor_type).toBe("user");
    expect(entry?.actor_id).toBe(caller.principalId);
    expect(entry?.result).toBe("denied");
    expect(entry?.reason).toBe("request_outside_declared_boundary");
    expect((entry?.metadata as { request_source?: string })?.request_source).toBe("mcp");
    expect((entry?.metadata as { step_key?: string })?.step_key).toBe("send");
    expect((entry?.metadata as { detail?: string })?.detail).toContain("outside the boundary");
  });

  test("a refused API execution with no caller context remains unknown", async () => {
    const rows = await refuse(
      "request_outside_declared_boundary",
      "outside the boundary",
      null,
      "api",
    );
    const entry = rows.find((row) => row.action === "execution.boundary_refused");
    expect(entry?.actor_type).toBe("unknown");
    expect(entry?.actor_id).toBeNull();
    expect(entry?.result).toBe("denied");
    expect((entry?.metadata as { request_source?: string })?.request_source).toBe("api");
  });

  test("a typed system account remains a system account on refusal", async () => {
    const caller: CallerContext = {
      tenantId,
      principalId: "00000000-0000-4000-8000-000000000002",
      principalKind: "system_account",
      provider: "api_key",
      productId: null,
    };
    const rows = await refuse("request_outside_declared_boundary", "outside the boundary", caller);
    const entry = rows.find((row) => row.action === "execution.boundary_refused");
    expect(entry?.actor_type).toBe("system_account");
    expect(entry?.actor_id).toBe(caller.principalId);
    expect(entry?.result).toBe("denied");
  });

  test("the real refusal code is what the runtime reports, not a blanket one", async () => {
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
    const rows = await refuse("execution_boundary_exhausted");
    expect(rows.some((row) => row.action === "execution.boundary_refused")).toBe(false);
  });

  test("an ordinary failure is not a governance event", async () => {
    for (const code of ["http_4xx", null]) {
      const rows = await refuse(code);
      expect(rows.some((row) => row.action === "execution.boundary_refused")).toBe(false);
    }
  });
});

describe("finalizeExecution — queued-only guard", () => {
  test("queued → aborted succeeds", async () => {
    const id = await newQueued();
    await finalizeExecution(db, tenantId, id, "aborted", null, null, ["queued"]);
    expect(await statusOf(id)).toBe("aborted");
  });

  test("a running row is left untouched by the queued-only finalize", async () => {
    const id = await newQueued();
    await markExecutionRunning(db, tenantId, id, new Date(FROZEN_NOW));
    await finalizeExecution(db, tenantId, id, "aborted", null, null, ["queued"]);
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

describe("runExecution — input validation", () => {
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
    expect(after.length).toBe(before.length);
  });
});
