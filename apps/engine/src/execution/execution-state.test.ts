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
