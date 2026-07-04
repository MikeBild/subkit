// Integration test for the proactive stdlib drift scan. Seeds
// workflows and request hooks with a range of recorded versions and
// asserts that only major-gap rows produce DriftSignal entries.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { requestHooks, tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { STDLIB_VERSION } from "../../sandboxes/quickjs/stdlib/index.ts";
import { scanStdlibDrift } from "../stdlib-drift-scan.ts";

let testDb: TestDb;
let tenantId: string;

beforeEach(async () => {
  testDb = await createTestDb("stdlib-scan");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "stdlib-scan", display_name: "Stdlib Scan" })
    .returning();
  if (!tenant) throw new Error("tenant insert failed");
  tenantId = tenant.id;
});

afterEach(async () => {
  await testDb.cleanup();
});

let seededWorkflowCounter = 0;

async function seedWorkflow(dag: Record<string, unknown>): Promise<string> {
  seededWorkflowCounter += 1;
  const [wf] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: `wf-${seededWorkflowCounter}`,
      name: "wf",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("wf insert failed");
  const [v] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: wf.id,
      version: 1,
      dag,
    })
    .returning();
  if (!v) throw new Error("version insert failed");
  const { eq } = await import("drizzle-orm");
  await testDb.db
    .update(workflows)
    .set({ current_version_id: v.id })
    .where(eq(workflows.id, wf.id));
  return wf.id;
}

describe("scanStdlibDrift", () => {
  test("empty tenant yields no signals", async () => {
    const out = await scanStdlibDrift(tenantId, testDb.db);
    expect(out).toEqual([]);
  });

  test("workflow without runtime metadata yields no signal", async () => {
    await seedWorkflow({
      name: "plain",
      steps: [{ kind: "request", id: "r", method: "GET", url: "https://x" }],
    });
    const out = await scanStdlibDrift(tenantId, testDb.db);
    expect(out).toEqual([]);
  });

  test("workflow with current stdlib version yields no signal", async () => {
    await seedWorkflow({
      name: "ok",
      steps: [{ kind: "request", id: "r", method: "GET", url: "https://x" }],
      runtime: { stdlib_version: STDLIB_VERSION },
    });
    const out = await scanStdlibDrift(tenantId, testDb.db);
    expect(out).toEqual([]);
  });

  test("workflow with older major surfaces a drift signal", async () => {
    const wfId = await seedWorkflow({
      name: "drifted",
      steps: [{ kind: "request", id: "r", method: "GET", url: "https://x" }],
      runtime: { stdlib_version: "0.9.0" },
    });
    const out = await scanStdlibDrift(tenantId, testDb.db);
    expect(out.length).toBe(1);
    const s = out[0];
    if (s?.kind !== "stdlib_version_drift") throw new Error("expected stdlib_version_drift");
    expect(s.surface).toBe("workflow");
    expect(s.resource_id).toBe(wfId);
    expect(s.recorded_version).toBe("0.9.0");
    expect(s.current_version).toBe(STDLIB_VERSION);
  });

  test("enabled request hook with older major surfaces a drift signal", async () => {
    const [row] = await testDb.db
      .insert(requestHooks)
      .values({
        tenant_id: tenantId,
        role: "member",
        source: "return sk.allow();",
        version: 1,
        enabled: true,
        stdlib_version: "0.1.0",
      })
      .returning();
    if (!row) throw new Error("hook seed failed");

    const out = await scanStdlibDrift(tenantId, testDb.db);
    expect(out.length).toBe(1);
    const s = out[0];
    if (s?.kind !== "stdlib_version_drift") throw new Error("expected stdlib_version_drift");
    expect(s.surface).toBe("request_hook");
    expect(s.resource_id).toBe(row.id);
    expect(s.recorded_version).toBe("0.1.0");
  });

  test("disabled hooks are not scanned", async () => {
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role: "member",
      source: "return sk.allow();",
      version: 1,
      enabled: false,
      stdlib_version: "0.1.0",
    });
    const out = await scanStdlibDrift(tenantId, testDb.db);
    expect(out).toEqual([]);
  });

  test("hooks without a recorded stdlib_version are treated as compatible", async () => {
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role: "member",
      source: "return { allow: true };",
      version: 1,
      enabled: true,
      stdlib_version: null,
    });
    const out = await scanStdlibDrift(tenantId, testDb.db);
    expect(out).toEqual([]);
  });
});
