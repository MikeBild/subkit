// test_rbac_expression — covers BOTH input modes the wave-3 rewrite
// introduced. The actor_probe path goes through the live RBAC
// evaluator (DB-backed); the expression_preview path is stateless
// JSONata. Pre-fix the wave-3 union schema serialised to anyOf at
// the JSON-Schema root, which the Anthropic API rejected — the
// tool-anthropic-conformance lint now catches that, and this test
// pins the per-mode happy + sad paths.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { tenants, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import type { ToolContext } from "../index.ts";
import { testRbacExpressionTool } from "../test-rbac-expression.ts";

const uuid = createDeterministicUuidFactory(0x7a51_dabcd);

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;

function makeToolCtx(): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: uuid(),
    actor_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id, db: ctx.db }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal draft stub for unit tests
    getDraft: () => ({ workflow: { name: "t", steps: [] } }) as any,
    setDraft: async () => {},
  };
}

beforeAll(async () => {
  ctx = await createTestDb("rbac_expr_tool");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-trex", display_name: "T-TREX" })
    .returning();
  tenant_id = t!.id;
  const [u] = await ctx.db
    .insert(users)
    .values({ tenant_id, email: "rbac-probe@example.com", role: "admin" })
    .returning();
  actor_id = u!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("test_rbac_expression · expression_preview", () => {
  test("truthy JSONata predicate → allow=true", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "expression_preview",
      expression: "$config.kind = 'request'",
      step_config: { kind: "request", url: "https://example.com" },
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: { allow: boolean; mode: string } }).data;
    expect(data.mode).toBe("expression_preview");
    expect(data.allow).toBe(true);
  });

  test("falsy JSONata predicate → allow=false", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "expression_preview",
      expression: "$config.kind = 'transform'",
      step_config: { kind: "request" },
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: { allow: boolean } }).data;
    expect(data.allow).toBe(false);
  });

  test("malformed expression → expression_invalid", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "expression_preview",
      expression: "$config.kind = ===",
      step_config: { kind: "request" },
    });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("expression_invalid");
  });

  test("missing step_config → typed missing-fields error (not crash)", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "expression_preview",
      expression: "$config.kind = 'request'",
    });
    expect(result.ok).toBe(false);
    const data = (result as { data: { error: string } }).data;
    expect(data.error).toBe("missing_required_fields");
  });

  test("missing expression → typed missing-fields error", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "expression_preview",
      step_config: { kind: "request" },
    });
    expect(result.ok).toBe(false);
    const data = (result as { data: { error: string } }).data;
    expect(data.error).toBe("missing_required_fields");
  });

  test("predicate using $config.<deep.path> reaches into nested config", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "expression_preview",
      expression: "$config.headers.\"Content-Type\" = 'application/json'",
      step_config: { headers: { "Content-Type": "application/json" } },
    });
    expect(result.ok).toBe(true);
    expect((result as { data: { allow: boolean } }).data.allow).toBe(true);
  });
});

describe("test_rbac_expression · actor_probe", () => {
  test("default mode is actor_probe (omitted mode field)", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      actor_id,
      permission: "workflow:read",
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: { actor_id: string; allow: boolean } }).data;
    expect(data.actor_id).toBe(actor_id);
    // admin has workflow:read by default seed.
    expect(typeof data.allow).toBe("boolean");
  });

  test("missing actor_id → typed missing-fields error", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "actor_probe",
      permission: "workflow:read",
    });
    expect(result.ok).toBe(false);
    const data = (result as { data: { error: string } }).data;
    expect(data.error).toBe("missing_required_fields");
  });

  test("missing permission → typed missing-fields error", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "actor_probe",
      actor_id,
    });
    expect(result.ok).toBe(false);
    const data = (result as { data: { error: string } }).data;
    expect(data.error).toBe("missing_required_fields");
  });

  test("actor_id pointing at non-existent user → actor_not_found_in_tenant", async () => {
    const result = await testRbacExpressionTool.execute(makeToolCtx(), {
      mode: "actor_probe",
      actor_id: "00000000-0000-0000-0000-000000000000",
      permission: "workflow:read",
    });
    expect(result.ok).toBe(false);
    expect((result as { data: { error: string } }).data.error).toBe("actor_not_found_in_tenant");
  });
});
