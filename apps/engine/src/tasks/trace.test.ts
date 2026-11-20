import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { projectAuditEntry } from "../audit/projection.ts";
import { queryAuditLog } from "../audit/query.ts";
import { AuditAction } from "../audit/types.ts";
import { auditLog } from "../db/schema/audit.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getContext, withContext } from "../logging/context.ts";
import { withJobContext } from "../queue/job-context.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { taskRunLogContext, withTaskRunAuditTrace, withTaskRunTrace } from "./trace.ts";

const TRACE = "0123456789abcdef0123456789abcdef";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";

describe("taskRunLogContext", () => {
  test("a scheduled run restores its trace, the scheduler origin and its conversation", () => {
    for (const trigger of ["cron", "once"]) {
      expect(
        taskRunLogContext({ trace_id: TRACE, trigger, conversation_id: CONVERSATION }),
      ).toEqual({
        audit_access_type: "task_run",
        trace_id: TRACE,
        audit_trace_id: TRACE,
        audit_origin_source: "scheduler",
        conversation_id: CONVERSATION,
      });
    }
  });

  test("a manual run claims no origin and a run without a conversation claims none", () => {
    expect(
      taskRunLogContext({ trace_id: TRACE, trigger: "manual", conversation_id: null }),
    ).toEqual({ audit_access_type: "task_run", trace_id: TRACE, audit_trace_id: TRACE });
  });

  test("a malformed stored trace id is not restored", () => {
    const context = taskRunLogContext({
      trace_id: "not-a-trace",
      trigger: "manual",
      conversation_id: null,
    });
    expect(Object.hasOwn(context, "audit_trace_id")).toBe(false);
    expect(Object.hasOwn(context, "trace_id")).toBe(false);
  });
});

describe("withTaskRunTrace", () => {
  test("it replaces the fresh trace a queue job was given and keeps the rest of the job context", () => {
    const seen = withJobContext({ tenant_id: "t-1" }, () => {
      const fresh = getContext().audit_trace_id;
      const restored = withTaskRunTrace(
        { trace_id: TRACE, trigger: "cron", conversation_id: CONVERSATION },
        () => ({ ...getContext() }),
      );
      return { fresh, restored, after: getContext().audit_trace_id };
    });
    expect(seen.fresh).not.toBe(TRACE);
    expect(seen.restored).toMatchObject({
      tenant_id: "t-1",
      request_source: "queue",
      audit_execution_source: "queue",
      audit_trace_id: TRACE,
      audit_origin_source: "scheduler",
      conversation_id: CONVERSATION,
      audit_access_type: "task_run",
    });
    expect(seen.after).toBe(seen.fresh);
  });

  test("a manual run in the background keeps the origin its job already carries", () => {
    const origin = withContext({ audit_origin_source: "ui" }, () =>
      withTaskRunTrace(
        { trace_id: TRACE, trigger: "manual", conversation_id: null },
        () => getContext().audit_origin_source,
      ),
    );
    expect(origin).toBe("ui");
  });

  test("a request with a person's session or API key keeps its own access type and trace", () => {
    const run = { trace_id: TRACE, trigger: "cron", conversation_id: CONVERSATION };
    const ambient = [
      { session_id: "s-1", audit_access_type: "browser_session" as const },
      { api_key_id: "k-1", audit_access_type: "api_key" as const },
      { audit_access_type: "mcp_oauth" as const },
      { session_id: "s-2" },
      { api_key_id: "k-2" },
    ];
    for (const person of ambient) {
      const before = {
        ...person,
        audit_trace_id: "f".repeat(32),
        audit_origin_source: "ui" as const,
      };
      const seen = withContext(before, () => withTaskRunTrace(run, () => ({ ...getContext() })));
      expect(seen).toEqual(before);
    }
  });

  test("a background context that already belongs to a run is restored again", () => {
    const seen = withContext(
      { audit_access_type: "task_run", audit_trace_id: "e".repeat(32) },
      () =>
        withTaskRunTrace(
          { trace_id: TRACE, trigger: "once", conversation_id: null },
          () => getContext().audit_trace_id,
        ),
    );
    expect(seen).toBe(TRACE);
  });
});

describe("withTaskRunAuditTrace", () => {
  test("a background write of a run carries the correlation id of the run and nothing else", () => {
    const seen = withContext({ audit_trace_id: "e".repeat(32), request_source: "scheduler" }, () =>
      withTaskRunAuditTrace({ trace_id: TRACE }, () => ({ ...getContext() })),
    );
    expect(seen).toEqual({ audit_trace_id: TRACE, request_source: "scheduler" });
  });

  test("a person's request and a malformed stored trace keep the ambient correlation id", () => {
    const person = withContext({ session_id: "s-1", audit_trace_id: "f".repeat(32) }, () =>
      withTaskRunAuditTrace({ trace_id: TRACE }, () => getContext().audit_trace_id),
    );
    expect(person).toBe("f".repeat(32));
    const malformed = withContext({ audit_trace_id: "f".repeat(32) }, () =>
      withTaskRunAuditTrace({ trace_id: "not-a-trace" }, () => getContext().audit_trace_id),
    );
    expect(malformed).toBe("f".repeat(32));
  });
});

describe("audit entries written inside a restored run context", () => {
  let testDb: TestDb;
  let tenantId = "";

  beforeAll(async () => {
    testDb = await createTestDb("task-trace");
    tenantId = (await seedTenant(testDb.db, { slug: "task-trace", display_name: "Trace" })).id;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  test("two separate jobs of one run share one correlation id and are found by it", async () => {
    const run = { trace_id: TRACE, trigger: "cron", conversation_id: CONVERSATION };
    for (const action of [AuditAction.TASK_RUN_STARTED, AuditAction.TASK_RUN_WAITING]) {
      await withJobContext({ tenant_id: tenantId }, () =>
        withTaskRunTrace(run, () =>
          auditAwait(
            {
              tenant_id: tenantId,
              actor_type: "system",
              action,
              resource_type: "task_run",
              resource_id: RUN,
              metadata: { task_id: TASK },
            },
            testDb.db,
          ),
        ),
      );
    }
    await withJobContext({ tenant_id: tenantId }, () =>
      auditAwait(
        {
          tenant_id: tenantId,
          actor_type: "system",
          action: AuditAction.TASK_RUN_FAILED,
          resource_type: "task_run",
          resource_id: RUN,
        },
        testDb.db,
      ),
    );
    const correlated = await queryAuditLog(testDb.db, {
      tenant_id: tenantId,
      correlation_id: TRACE,
    });
    expect(correlated.items.map((item) => item.action).sort()).toEqual([
      AuditAction.TASK_RUN_STARTED,
      AuditAction.TASK_RUN_WAITING,
    ]);
    const projected = correlated.items.map(projectAuditEntry);
    for (const entry of projected) {
      expect(entry).toMatchObject({
        correlation_id: TRACE,
        origin_source: "scheduler",
        execution_source: "queue",
        request_source: "queue",
        access_type: "task_run",
        conversation_id: CONVERSATION,
        task_id: TASK,
        task_run_id: RUN,
      });
    }
    const all = await testDb.db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId));
    expect(all).toHaveLength(3);
    expect(
      (await queryAuditLog(testDb.db, { tenant_id: tenantId, access_type: "task_run" })).items,
    ).toHaveLength(2);
  });
});
