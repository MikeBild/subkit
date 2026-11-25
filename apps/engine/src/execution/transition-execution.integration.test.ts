import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import type { ExecutionStatus } from "./core/status.ts";
import { createExecution, transitionExecution } from "./state.ts";

let testDb: TestDb;
let db: Db;
let tenantId = "";

beforeAll(async () => {
  testDb = await createTestDb("transition-execution");
  db = testDb.db;
  const t = await seedTenant(db, { slug: "exec-transition", display_name: "Exec Transition" });
  tenantId = t.id;
});

afterAll(async () => {
  if (testDb) await testDb.cleanup();
});

async function executionIn(status: ExecutionStatus): Promise<string> {
  const id = await createExecution(db, {
    tenant_id: tenantId,
    workflow_id: null,
    workflow_version_id: null,
    source_kind: "draft",
    source_ref: null,
    request_source: "api",
  });
  await db.update(executions).set({ status }).where(eq(executions.id, id));
  return id;
}

async function rowOf(id: string) {
  const [row] = await db
    .select({ status: executions.status, budget_park: executions.budget_park })
    .from(executions)
    .where(eq(executions.id, id));
  return row;
}

describe("transitionExecution", () => {
  test("a budget park moves a running execution back to queued", async () => {
    const id = await executionIn("running");
    const park = {
      step_id: "s1",
      month: "2026-11",
      parked_at: "2026-11-25T00:00:00.000Z",
      scope: {},
    };
    const row = await transitionExecution(db, {
      tenant_id: tenantId,
      execution_id: id,
      from: ["running"],
      to: "queued",
      set: { budget_park: park },
    });
    expect(row?.id).toBe(id);
    expect(await rowOf(id)).toEqual({ status: "queued", budget_park: park });
  });

  test("a waiting execution re-enters the device wait", async () => {
    const id = await executionIn("waiting_for_device");
    const row = await transitionExecution(db, {
      tenant_id: tenantId,
      execution_id: id,
      from: ["queued", "waiting_for_device"],
      to: "waiting_for_device",
    });
    expect(row?.id).toBe(id);
    expect((await rowOf(id))?.status).toBe("waiting_for_device");
  });

  test("a waiting execution returns to queued", async () => {
    const id = await executionIn("waiting_for_device");
    const row = await transitionExecution(db, {
      tenant_id: tenantId,
      execution_id: id,
      from: ["waiting_for_device"],
      to: "queued",
    });
    expect(row?.id).toBe(id);
    expect((await rowOf(id))?.status).toBe("queued");
  });

  test("a forbidden transition writes nothing", async () => {
    const id = await executionIn("succeeded");
    const row = await transitionExecution(db, {
      tenant_id: tenantId,
      execution_id: id,
      from: ["succeeded"],
      to: "queued",
    });
    expect(row).toBeNull();
    expect((await rowOf(id))?.status).toBe("succeeded");
  });

  test("a row outside the expected sources is left alone", async () => {
    const id = await executionIn("uncertain");
    const row = await transitionExecution(db, {
      tenant_id: tenantId,
      execution_id: id,
      from: ["running"],
      to: "queued",
    });
    expect(row).toBeNull();
    expect((await rowOf(id))?.status).toBe("uncertain");
  });
});
