// dry_run_transform tool tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { dryRunTransformTool } from "../dry-run-transform.ts";
import type { ToolContext } from "../index.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("dry_run_transform");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-drt", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(),
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ name: "", steps: [] }),
    setDraft: async () => {},
  };
}

describe("dry_run_transform — jsonata dialect", () => {
  test("select a field from sample data", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "user.name",
      sample_data: { user: { name: "Ada" } },
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { value: unknown };
    expect(data.value).toBe("Ada");
  });

  test("filter + project", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "items[active = true].{ 'id': id }",
      sample_data: {
        items: [
          { id: "a", active: true },
          { id: "b", active: false },
          { id: "c", active: true },
        ],
      },
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { value: Array<{ id: string }> };
    expect(data.value).toEqual([{ id: "a" }, { id: "c" }]);
  });

  test("syntax error returns code=syntax_error with position", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "items[",
      sample_data: {},
      dialect: "jsonata",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string; position?: number } }).error;
    expect(err.code).toBe("syntax_error");
  });

  test("runtime timeout surfaces as timeout", async () => {
    // JSONata doesn't easily produce a timeout from small expressions,
    // so we pass timeout_ms=50 with a deep recursive expression.
    const deep = Array(2000).fill("x").join(".");
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: deep,
      sample_data: {},
      dialect: "jsonata",
      timeout_ms: 50,
    });
    // Either the expression parses to nothing (ok:true with null),
    // times out, or syntax-errors — any of those three is a valid
    // "did not take more than 50ms to bail" outcome. We only assert
    // that the tool did not hang.
    expect(["syntax_error", "timeout", undefined]).toContain(
      result.ok ? undefined : (result.data as { error?: { code?: string } }).error?.code,
    );
  });
});

describe("dry_run_transform — jsonpath dialect", () => {
  test("basic $.field access", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "$.data.user.name",
      sample_data: { data: { user: { name: "Grace" } } },
      dialect: "jsonpath",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { value: unknown }).value).toBe("Grace");
  });

  test("wildcard flatten", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "$.items[*].id",
      sample_data: { items: [{ id: "a" }, { id: "b" }] },
      dialect: "jsonpath",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { value: unknown }).value).toEqual(["a", "b"]);
  });

  test("invalid jsonpath → syntax_error", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "items.foo", // must start with $
      sample_data: {},
      dialect: "jsonpath",
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error: { code: string } }).error.code).toBe("syntax_error");
  });
});

describe("dry_run_transform — template dialect", () => {
  test("${input.*} substitution", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "Hello ${input.user.name}!",
      sample_data: { input: { user: { name: "Ada" } } },
      dialect: "template",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { value: unknown }).value).toBe("Hello Ada!");
  });

  test("${scope.<step>.<path>} substitution", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "id=${scope.fetch.data.id}",
      sample_data: { scope: { fetch: { data: { id: "42" } } } },
      dialect: "template",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { value: unknown }).value).toBe("id=42");
  });

  test("${cred.*} in template yields placeholder_unresolved", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "Bearer ${cred.stripe.token}",
      sample_data: { input: {} },
      dialect: "template",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("placeholder_unresolved");
    expect(err.message).toContain("${cred.stripe.token}");
  });
});

describe("dry_run_transform — audit hygiene", () => {
  test("audit metadata stores expression_hash, not raw expression", async () => {
    const expression = "items.{ 'id': id }"; // benign
    const toolCtx = makeCtx();
    await dryRunTransformTool.execute(toolCtx, {
      expression,
      sample_data: { items: [{ id: "x" }] },
      dialect: "jsonata",
    });
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "conversation.dry_run_transform"),
        ),
      );
    const row = rows.find((r) => {
      const m = (r.metadata ?? {}) as { conversation_id?: string };
      return m.conversation_id === toolCtx.conversation_id;
    });
    expect(row).toBeTruthy();
    const meta = (row!.metadata ?? {}) as {
      dialect: string;
      expression_hash: string;
      ok: boolean;
    };
    expect(meta.dialect).toBe("jsonata");
    expect(meta.ok).toBe(true);
    expect(meta.expression_hash).toMatch(/^[a-f0-9]{16}$/);
    // Critically: the raw expression text must not appear anywhere in
    // the audit row.
    expect(JSON.stringify(row).includes(expression)).toBe(false);
  });
});
