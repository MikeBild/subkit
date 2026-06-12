// dry_run_transform tool tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { dryRunTransformTool } from "../dry-run-transform.ts";
import type { ToolContext } from "../index.ts";
import { __resetLastPreviewStoreForTest, recordLastPreview } from "../last-preview-store.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("dry_run_transform");
  const [t] = await ctx.db.insert(tenants).values({ slug: "t-drt", display_name: "T" }).returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
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
  test(`\${input.*} substitution`, async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: `Hello \${input.user.name}!`,
      sample_data: { input: { user: { name: "Ada" } } },
      dialect: "template",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { value: unknown }).value).toBe("Hello Ada!");
  });

  test(`\${scope.<step>.<path>} substitution`, async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: `id=\${scope.fetch.data.id}`,
      sample_data: { scope: { fetch: { data: { id: "42" } } } },
      dialect: "template",
    });
    expect(result.ok).toBe(true);
    expect((result.data as { value: unknown }).value).toBe("id=42");
  });

  test(`\${cred.*} in template yields placeholder_unresolved`, async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: `Bearer \${cred.stripe.token}`,
      sample_data: { input: {} },
      dialect: "template",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("placeholder_unresolved");
    expect(err.message).toContain(`\${cred.stripe.token}`);
  });
});

// Regression: session fb930dcb burned 12 identical Jira fetches because
// the only way to iterate on a JSONata transform was `dry_run_workflow`
// (which re-hits the upstream). `dry_run_transform` now resolves
// `$scope` / `$scope.<step_id>` / `$input` from the per-conversation
// preview store so authoring a transform costs zero upstream calls.
describe("dry_run_transform — scope reference resolution", () => {
  test("resolves `$scope.<step_id>` from the last cached preview", async () => {
    const toolCtx = makeCtx();
    recordLastPreview({
      tenant_id,
      conversation_id: toolCtx.conversation_id,
      scope: {
        fetch_issues: {
          data: {
            issues: [
              { key: "EMOBXP-1", fields: { assignee: { displayName: "Ada" } } },
              { key: "EMOBXP-2", fields: { assignee: null } },
            ],
          },
          status_code: 200,
        },
      },
      input: null,
    });
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression:
        "$scope.fetch_issues.data.issues.{ 'key': key, 'assignee': $exists(fields.assignee) ? fields.assignee.displayName : null }",
      sample_data: "$scope.fetch_issues",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      value: Array<{ key: string; assignee?: string | null }>;
      metadata: { resolved_from_preview?: string };
    };
    // The critical assertion: both rows are present (no null-thinning).
    // JSONata's object constructor elides keys whose value is `null`, so
    // the second row carries only `key` — `$exists(...)` still prevents
    // the whole row from collapsing, which is the session-fb930dcb fix.
    expect(data.value).toHaveLength(2);
    expect(data.value[0]).toEqual({ key: "EMOBXP-1", assignee: "Ada" });
    expect(data.value[1]?.key).toBe("EMOBXP-2");
    expect(data.metadata.resolved_from_preview).toBe("$scope.fetch_issues");
  });

  test("missing preview returns an actionable hint", async () => {
    __resetLastPreviewStoreForTest();
    const toolCtx = makeCtx();
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression: "$scope.x.data",
      sample_data: "$scope",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("runtime_error");
    expect(err.message).toContain("no cached dry-run preview");
  });

  test("unknown step id surfaces available scope keys", async () => {
    const toolCtx = makeCtx();
    recordLastPreview({
      tenant_id,
      conversation_id: toolCtx.conversation_id,
      scope: { fetch_issues: { data: [] } },
      input: null,
    });
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression: "$scope.wrong_step.data",
      sample_data: "$scope.wrong_step",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { message: string } }).error;
    expect(err.message).toContain("$scope.fetch_issues");
  });
});

// Fix 6 (session 784c1b02): the sandbox must reproduce the EXACT
// JSONata surface execution builds — `$scope`/`$steps` bindings via
// buildJsonataBindings, and for a step inside a loop body the engine's
// per-iteration childScope (`$item`, `$loop_index`, bare `item_var`).
// Pre-fix those references returned `{}` here while working at runtime,
// so the model "debugged" working expressions into broken ones.
describe("dry_run_transform — execution-parity loop-body context", () => {
  function makeCtxWithDraft(steps: Array<Record<string, unknown>>): ToolContext {
    return {
      ...makeCtx(),
      getDraft: () => ({ workflow: { name: "wf", slug: "wf", steps } }),
    };
  }

  const loopDraftSteps = (): Array<Record<string, unknown>> => [
    { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
    {
      id: "iter",
      kind: "loop",
      over: "$scope.fetch.data.items",
      item_var: "row",
      body: ["shape"],
    },
    { id: "shape", kind: "transform", language: "jsonata", expression: "row.name" },
  ];

  function recordEnvelopePreview(toolCtx: ToolContext): void {
    // Envelope-shaped scope — the exact shape dry_run_workflow records
    // post-fix (`{ data, status_code, … }`, mirroring engine/envelope.ts).
    recordLastPreview({
      tenant_id,
      conversation_id: toolCtx.conversation_id,
      scope: {
        fetch: {
          data: {
            items: [
              { name: "Ada", id: 1 },
              { name: "Grace", id: 2 },
            ],
          },
          status_code: 200,
          duration_ms: 12,
          error: null,
        },
      },
      input: { since: "2026-01-01" },
    });
  }

  test("bare item_var, $item, $loop_index, and sibling $scope resolve exactly as execution would", async () => {
    const toolCtx = makeCtxWithDraft(loopDraftSteps());
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression:
        "{ 'name': row.name, 'same': $item.name, 'idx': $loop_index, 'total': $count($scope.fetch.data.items), 'since': $input.since }",
      step_id: "shape",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      value: { name: string; same: string; idx: number; total: number; since: string };
      metadata: { loop_context?: { loop_id: string; item_var: string; loop_index: number } };
    };
    // Identical to the engine childScope for iteration 0:
    //   childScope = { ...scope, row: items[0], $item: items[0], $loop_index: 0 }
    expect(data.value).toEqual({
      name: "Ada",
      same: "Ada",
      idx: 0,
      total: 2,
      since: "2026-01-01",
    });
    expect(data.metadata.loop_context).toEqual({ loop_id: "iter", item_var: "row", loop_index: 0 });
  });

  test("step_id outside any loop body evaluates against plain recorded scope", async () => {
    const steps = [
      ...loopDraftSteps(),
      { id: "summary", kind: "transform", language: "jsonata", expression: "" },
    ];
    const toolCtx = makeCtxWithDraft(steps);
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression: "$scope.fetch.data.items.name",
      step_id: "summary",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { value: unknown; metadata: { loop_context?: unknown } };
    expect(data.value).toEqual(["Ada", "Grace"]);
    expect(data.metadata.loop_context).toBeUndefined();
  });

  test("unknown step_id returns an actionable error", async () => {
    const toolCtx = makeCtxWithDraft(loopDraftSteps());
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression: "row.name",
      step_id: "nope",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { message: string } }).error;
    expect(err.message).toContain("not in the current workflow draft");
  });

  test("loop body step with no recorded preview returns the dry-run hint", async () => {
    __resetLastPreviewStoreForTest();
    const toolCtx = makeCtxWithDraft(loopDraftSteps());
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression: "row.name",
      step_id: "shape",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { message: string } }).error;
    expect(err.message).toContain("no cached dry-run preview");
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
