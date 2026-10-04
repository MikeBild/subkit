import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { evaluateHook } from "../../../auth/hooks.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { requestHooks, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("sbx-hook");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "sbx-hook", display_name: "Sandbox Hook Test" })
    .returning();
  if (!tenant) throw new Error("tenant insert failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

function principal(): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: tenantId,
    roles: ["member"],
  };
}

describe("before-request hook", () => {
  test("hook returning { allow: true } permits the request", async () => {
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role: "member",
      source: "return { allow: true };",
      version: 1,
      enabled: true,
    });
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal(),
      requestCtx: {
        method: "GET",
        url: "https://example.com/ok",
        headers: {},
        execution_id: "exec-1",
        workflow_id: "wf-1",
        step_id: "fetch",
      },
    });
    expect(decision.allowed).toBe(true);
  });

  test("hook that throws denies the request with reason hook_error", async () => {
    const badPrincipal: ResolvedPrincipal = { ...principal(), roles: ["bad-role"] };
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role: "bad-role",
      source: "throw new Error('boom');",
      version: 1,
      enabled: true,
    });
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: badPrincipal,
      requestCtx: {
        method: "POST",
        url: "https://example.com/kaboom",
        headers: {},
        execution_id: "exec-2",
        workflow_id: "wf-1",
        step_id: "fetch",
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("hook_error");
  });
});
