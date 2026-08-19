// Migration 0040 — the foreign key on `llm_usage.execution_id`, and the two
// properties that make it the right constraint rather than merely a
// constraint.
//
// Until 0040 the column had no foreign key. Anything uuid-shaped was accepted
// and thereafter looked exactly like an execution reference: 163 rows carried
// a `self_healing_scans.id` for two months without a single error or log line,
// because a wrong-but-valid uuid produces neither — only a join that quietly
// returns nothing.
//
// Two properties are pinned here, and they pull in opposite directions:
//
//   1. A reference that names no execution is REFUSED. This is what makes the
//      column's claim true.
//   2. Deleting an execution NULLs the reference and KEEPS the row. This table
//      is an append-only financial ledger — the tokens were spent and the
//      provider billed them. ON DELETE CASCADE would satisfy property 1 just
//      as well while destroying billing history, which is why `user_id` on
//      this same table carries no foreign key at all. SET NULL is what lets
//      the ledger have both.
//
// A test that only checked property 1 would pass against CASCADE.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { executions, llmUsage, tenants, workflows } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

const skip = process.env.REQUIRES_PG === "0";

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
    // 'n' = SET NULL. 'c' would be CASCADE — see the header: that would
    // delete billing rows.
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
    // Shaped exactly like the `self_healing_scans.id` values that used to
    // land here: a perfectly well-formed uuid belonging to another table.
    const strayScanId = "8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d";
    // Caught explicitly rather than via `.rejects`: the Drizzle insert builder
    // is a thenable, and the assertion helper reports its internals instead of
    // the Postgres error. We want the constraint name in the failure message.
    let caught: unknown;
    try {
      await testDb.db.insert(llmUsage).values(row(strayScanId));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // Drizzle wraps the driver error with its own "Failed query" message and
    // keeps the Postgres one on `cause`, where the constraint name and
    // SQLSTATE live. Assert on those rather than on the wrapper, so this fails
    // if the row is rejected for some unrelated reason.
    const cause = (caught as { cause?: { constraint?: string; code?: string } }).cause;
    expect(cause?.constraint).toBe("llm_usage_execution_id_executions_id_fk");
    expect(cause?.code).toBe("23503"); // foreign_key_violation

    // And nothing was written.
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
    // The row survives its execution.
    expect(after).toHaveLength(1);
    expect(after[0]?.execution_id).toBeNull();
    // And it still says what it cost.
    expect(after[0]?.total_tokens).toBe(110);
  });
});
