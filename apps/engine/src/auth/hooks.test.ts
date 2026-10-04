import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, requestHooks, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { evaluateHook, lintHookSource } from "./hooks.ts";
import type { ResolvedPrincipal } from "./types.ts";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("auth-hooks");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "auth-hooks", display_name: "Auth Hooks" })
    .returning();
  if (!tenant) throw new Error("tenant insert failed");
  tenantId = tenant.id;
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

function principal(roles: string[]): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: tenantId,
    roles,
  };
}

function ctx(overrides: Partial<Parameters<typeof evaluateHook>[0]["requestCtx"]> = {}) {
  return {
    method: "GET",
    url: "https://example.com/resource",
    headers: {},
    execution_id: "exec-1",
    workflow_id: "wf-1",
    step_id: "fetch",
    ...overrides,
  };
}

describe("evaluateHook — principal role gating", () => {
  test("a principal with no roles skips hook evaluation entirely (allowed)", async () => {
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal([]),
      requestCtx: ctx(),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.hook_id).toBeUndefined();
  });

  test("a role with no matching enabled hook rows is allowed", async () => {
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal(["role-with-no-hooks"]),
      requestCtx: ctx(),
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("evaluateHook — version collapse per role", () => {
  test("the latest version for a role wins over an older version", async () => {
    const role = "versioned-role";
    await testDb.db.insert(requestHooks).values([
      {
        tenant_id: tenantId,
        role,
        source: "return { allow: false, reason: 'old_version_denies' };",
        version: 1,
        enabled: true,
      },
      {
        tenant_id: tenantId,
        role,
        source: "return { allow: true };",
        version: 2,
        enabled: true,
      },
    ]);
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal([role]),
      requestCtx: ctx(),
    });
    expect(decision.allowed).toBe(true);
  });

  test("a disabled hook row for a role is never loaded", async () => {
    const role = "disabled-role";
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role,
      source: "return { allow: false, reason: 'should_never_run' };",
      version: 1,
      enabled: false,
    });
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal([role]),
      requestCtx: ctx(),
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("evaluateHook — deny outcomes and audit trail", () => {
  test("a hook returning { allow: false, reason } denies with that reason and writes an audit row", async () => {
    const role = "deny-with-reason";
    const [row] = await testDb.db
      .insert(requestHooks)
      .values({
        tenant_id: tenantId,
        role,
        source: "return { allow: false, reason: 'budget_exceeded' };",
        version: 1,
        enabled: true,
      })
      .returning();
    if (!row) throw new Error("seed hook failed");

    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal([role]),
      requestCtx: ctx({ method: "POST", url: "https://example.com/spend" }),
      trace_id: "trace-deny-1",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("budget_exceeded");
    expect(decision.hook_id).toBe(row.id);

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, row.id)));
    expect(audits.length).toBeGreaterThan(0);
    const last = audits[audits.length - 1]!;
    expect(last.action).toBe("policy.denied");
    expect(last.reason).toBe("budget_exceeded");
    expect(last.trace_id).toBe("trace-deny-1");
  });

  test("a hook returning { allow: false } with no reason defaults to hook_denied", async () => {
    const role = "deny-no-reason";
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role,
      source: "return { allow: false };",
      version: 1,
      enabled: true,
    });
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal([role]),
      requestCtx: ctx(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("hook_denied");
  });

  test("a hook returning a malformed shape (no allow key) denies with hook_error", async () => {
    const role = "malformed-shape";
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role,
      source: "return { nonsense: true };",
      version: 1,
      enabled: true,
    });
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal([role]),
      requestCtx: ctx(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("hook_error");
  });

  test("a hook returning a non-object (string) denies with hook_error", async () => {
    const role = "non-object-output";
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role,
      source: "return 'not-an-object';",
      version: 1,
      enabled: true,
    });
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal([role]),
      requestCtx: ctx(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("hook_error");
  });

  test("multiple roles: the first denying role (sorted order) short-circuits later roles", async () => {
    await testDb.db.insert(requestHooks).values([
      {
        tenant_id: tenantId,
        role: "role-a-first",
        source: "return { allow: false, reason: 'first_role_denied' };",
        version: 1,
        enabled: true,
      },
      {
        tenant_id: tenantId,
        role: "role-z-second",
        source: "return { allow: false, reason: 'second_role_denied' };",
        version: 1,
        enabled: true,
      },
    ]);
    const decision = await evaluateHook({
      db: testDb.db,
      tenant_id: tenantId,
      principal: principal(["role-a-first", "role-z-second"]),
      requestCtx: ctx(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("first_role_denied");
  });
});

describe("lintHookSource", () => {
  test("syntactically valid source lints ok", async () => {
    const result = await lintHookSource("return { allow: true };");
    expect(result.ok).toBe(true);
  });

  test("syntactically invalid source reports a SandboxSyntaxError message", async () => {
    const result = await lintHookSource("this is not valid js {{{");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("a runtime throw (not a syntax error) still lints ok — only syntax is rejected", async () => {
    const result = await lintHookSource("throw new Error('runtime, not syntax');");
    expect(result.ok).toBe(true);
  });
});
