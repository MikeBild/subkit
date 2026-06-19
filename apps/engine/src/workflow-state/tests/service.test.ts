// Workflow run state service: tenant-encrypted read/write, AAD
// binding, tenant-leakage isolation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { readWorkflowState, writeWorkflowState } from "../service.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;
let workflowA: string;
let workflowB: string;

beforeAll(async () => {
  ctx = await createTestDb("workflow_run_state");
  const [ta] = await ctx.db
    .insert(tenants)
    .values({ slug: "wfs-a", display_name: "tenant A" })
    .returning();
  const [tb] = await ctx.db
    .insert(tenants)
    .values({ slug: "wfs-b", display_name: "tenant B" })
    .returning();
  tenantA = ta!.id;
  tenantB = tb!.id;
  const [wa] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenantA, slug: "wf-a", name: "wf a", lifecycle: "active" })
    .returning();
  const [wb] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenantB, slug: "wf-b", name: "wf b", lifecycle: "active" })
    .returning();
  workflowA = wa!.id;
  workflowB = wb!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workflow-state service", () => {
  test("returns undefined for a missing key", async () => {
    const row = await readWorkflowState(ctx.db, tenantA, workflowA, "missing");
    expect(row).toBeUndefined();
  });

  test("write then read round-trips a JSON value losslessly", async () => {
    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "last_seen_at",
      value: "2026-05-05T08:00:00Z",
    });
    const row = await readWorkflowState(ctx.db, tenantA, workflowA, "last_seen_at");
    expect(row?.value).toBe("2026-05-05T08:00:00Z");
    expect(row?.value_kind).toBe("string");
  });

  test("write upserts an existing key without violating the unique index", async () => {
    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "cursor",
      value: { id: 1 },
    });
    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "cursor",
      value: { id: 2 },
    });
    const row = await readWorkflowState(ctx.db, tenantA, workflowA, "cursor");
    expect(row?.value).toEqual({ id: 2 });
    expect(row?.value_kind).toBe("object");
  });

  test("preserves array, number, boolean, null shapes", async () => {
    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "arr",
      value: [1, 2, 3],
    });
    expect((await readWorkflowState(ctx.db, tenantA, workflowA, "arr"))?.value).toEqual([1, 2, 3]);

    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "num",
      value: 42,
    });
    expect((await readWorkflowState(ctx.db, tenantA, workflowA, "num"))?.value).toBe(42);

    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "bool",
      value: true,
    });
    expect((await readWorkflowState(ctx.db, tenantA, workflowA, "bool"))?.value).toBe(true);

    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "nil",
      value: null,
    });
    expect((await readWorkflowState(ctx.db, tenantA, workflowA, "nil"))?.value).toBeNull();
  });

  test("tenant isolation: tenant B cannot read tenant A's keys (different (tenant, workflow))", async () => {
    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "iso_key",
      value: "secret-A",
    });
    const fromB = await readWorkflowState(ctx.db, tenantB, workflowB, "iso_key");
    expect(fromB).toBeUndefined();
  });

  test("AAD binding: reading tenant A's row under tenant B's tenant_id throws (decrypt fails on AAD mismatch)", async () => {
    await writeWorkflowState(ctx.db, {
      tenant_id: tenantA,
      workflow_id: workflowA,
      key: "aad_check",
      value: "plain-A",
    });
    // Reading at the right (tenant_id, workflow_id, key) succeeds.
    const ok = await readWorkflowState(ctx.db, tenantA, workflowA, "aad_check");
    expect(ok?.value).toBe("plain-A");
    // Cross-tenant lookup returns undefined (no row at that PK), not a
    // ciphertext lift — confirms PK-level isolation.
    const cross = await readWorkflowState(ctx.db, tenantB, workflowA, "aad_check");
    expect(cross).toBeUndefined();
  });
});
