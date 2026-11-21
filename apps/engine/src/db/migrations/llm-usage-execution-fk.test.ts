import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { executions, llmUsage, tenants, workflows } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

const skip = testEnv.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let executionId: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("llm-usage-exec-fk");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "llm-fk-tenant", display_name: "LLM FK Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [wf] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "fk-wf", name: "FK WF", lifecycle: "active" })
    .returning();
  const [exec] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf?.id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
    })
    .returning();
  if (!exec) throw new Error("seed execution failed");
  executionId = exec.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

function row(execution_id: string | null) {
  return {
    tenant_id: tenantId,
    flow: "repair",
    model: "claude-haiku-4-5",
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    latency_ms: 5,
    result: "success",
    month_bucket: 202608,
    execution_id,
  };
}

describe.skipIf(skip)("migration 0040 — llm_usage.execution_id foreign key", () => {
  test("the constraint exists with ON DELETE SET NULL", async () => {
    const res = await testDb.db.execute(sql`
      select confdeltype
        from pg_constraint
       where conrelid = 'llm_usage'::regclass
         and contype = 'f'
         and conname = 'llm_usage_execution_id_executions_id_fk'
    `);
    expect(res.rows).toHaveLength(1);
    expect((res.rows[0] as { confdeltype: string }).confdeltype).toBe("n");
  });

  test("a real execution reference is accepted", async () => {
    const [inserted] = await testDb.db.insert(llmUsage).values(row(executionId)).returning();
    expect(inserted?.execution_id).toBe(executionId);
  });

  test("null is accepted — a conversational call has no execution", async () => {
    const [inserted] = await testDb.db.insert(llmUsage).values(row(null)).returning();
    expect(inserted?.execution_id).toBeNull();
  });

  test("a uuid that names no execution is refused, not silently stored", async () => {
    const strayScanId = "8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d";
    let caught: unknown;
    try {
      await testDb.db.insert(llmUsage).values(row(strayScanId));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { constraint?: string; code?: string } }).cause;
    expect(cause?.constraint).toBe("llm_usage_execution_id_executions_id_fk");
    expect(cause?.code).toBe("23503");

    const rows = await testDb.db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.execution_id, strayScanId));
    expect(rows).toHaveLength(0);
  });

  test("deleting the execution NULLs the reference and keeps the billing row", async () => {
    const [wf] = await testDb.db
      .insert(workflows)
      .values({ tenant_id: tenantId, slug: "fk-wf-2", name: "FK WF 2", lifecycle: "active" })
      .returning();
    const [doomed] = await testDb.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: wf?.id,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
      })
      .returning();
    const [usage] = await testDb.db.insert(llmUsage).values(row(doomed!.id)).returning();

    await testDb.db.delete(executions).where(eq(executions.id, doomed!.id));

    const after = await testDb.db.select().from(llmUsage).where(eq(llmUsage.id, usage!.id));
    expect(after).toHaveLength(1);
    expect(after[0]?.execution_id).toBeNull();
    expect(after[0]?.total_tokens).toBe(110);
  });
});
