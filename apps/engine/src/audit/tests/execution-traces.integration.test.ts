import { describe, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { auditAwait } from "../audit.ts";
import { executionStartTraceId } from "../execution-traces.ts";
import { AuditAction, type AuditResult } from "../types.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb } from "./contracts-fixtures.ts";

useAuditContractsDb();

const uuid = createDeterministicUuidFactory(0xe7ace);

async function started(
  executionId: string,
  traceId: string,
  overrides: {
    tenant?: string;
    result?: AuditResult;
    action?: string;
    resource_type?: string;
  } = {},
) {
  await auditAwait(
    {
      tenant_id: overrides.tenant ?? tenantA,
      action: (overrides.action ??
        AuditAction.EXECUTION_STARTED) as typeof AuditAction.EXECUTION_STARTED,
      resource_type: overrides.resource_type ?? "execution",
      resource_id: executionId,
      result: overrides.result ?? "success",
      trace_id: traceId,
    },
    testDb.db,
  );
}

describe("executionStartTraceId", () => {
  test("returns the trace of the single successful start of an execution", async () => {
    const executionId = uuid();
    await started(executionId, "trace-one");
    expect(await executionStartTraceId(testDb.db, tenantA, executionId)).toBe("trace-one");
  });

  test("a repeated start with the same trace still resolves to that trace", async () => {
    const executionId = uuid();
    await started(executionId, "trace-same");
    await started(executionId, "trace-same");
    expect(await executionStartTraceId(testDb.db, tenantA, executionId)).toBe("trace-same");
  });

  test("two different start traces are ambiguous and resolve to null", async () => {
    const executionId = uuid();
    await started(executionId, "trace-a");
    await started(executionId, "trace-b");
    expect(await executionStartTraceId(testDb.db, tenantA, executionId)).toBeNull();
  });

  test("blank traces, failed starts and other actions or resource types are ignored", async () => {
    const executionId = uuid();
    await started(executionId, "");
    await started(executionId, "   ");
    await started(executionId, "trace-denied", { result: "denied" });
    await started(executionId, "trace-step", { action: AuditAction.EXECUTION_COMPLETED });
    await started(executionId, "trace-workflow", { resource_type: "workflow" });
    expect(await executionStartTraceId(testDb.db, tenantA, executionId)).toBeNull();
    await started(executionId, "trace-real");
    expect(await executionStartTraceId(testDb.db, tenantA, executionId)).toBe("trace-real");
  });

  test("another tenant's start never resolves and never makes this tenant ambiguous", async () => {
    const executionId = uuid();
    await started(executionId, "trace-foreign", { tenant: tenantB });
    expect(await executionStartTraceId(testDb.db, tenantA, executionId)).toBeNull();
    await started(executionId, "trace-own");
    expect(await executionStartTraceId(testDb.db, tenantA, executionId)).toBe("trace-own");
    expect(await executionStartTraceId(testDb.db, tenantB, executionId)).toBe("trace-foreign");
  });

  test("an unknown execution resolves to null", async () => {
    expect(await executionStartTraceId(testDb.db, tenantA, uuid())).toBeNull();
  });
});
