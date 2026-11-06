import { describe, expect, test } from "bun:test";
import { dryRunTransformTool } from "../dry-run-transform.ts";
import type { ToolContext } from "../index.ts";
import { __resetLastPreviewStoreForTest, recordLastPreview } from "../last-preview-store.ts";
import { makeCtx, tenant_id, useDryRunTransformSetup } from "./dry-run-transform-fixtures.ts";

useDryRunTransformSetup();

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
    const deep = Array(2000).fill("x").join(".");
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: deep,
      sample_data: {},
      dialect: "jsonata",
      timeout_ms: 50,
    });
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
      expression: "items.foo",
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
              { key: "ACME-1", fields: { assignee: { displayName: "Ada" } } },
              { key: "ACME-2", fields: { assignee: null } },
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
    expect(data.value).toHaveLength(2);
    expect(data.value[0]).toEqual({ key: "ACME-1", assignee: "Ada" });
    expect(data.value[1]?.key).toBe("ACME-2");
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
      body: ["shape"],
    },
    { id: "shape", kind: "transform", language: "jsonata", expression: "$item.name" },
  ];

  function recordEnvelopePreview(toolCtx: ToolContext): void {
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

  test("$item, $loop_index, and sibling $scope resolve exactly as execution would", async () => {
    const toolCtx = makeCtxWithDraft(loopDraftSteps());
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression:
        "{ 'name': $item.name, 'idx': $loop_index, 'total': $count($scope.fetch.data.items), 'since': $input.since }",
      step_id: "shape",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      value: { name: string; idx: number; total: number; since: string };
      metadata: { loop_context?: { loop_id: string; loop_index: number } };
    };
    expect(data.value).toEqual({
      name: "Ada",
      idx: 0,
      total: 2,
      since: "2026-01-01",
    });
    expect(data.metadata.loop_context).toEqual({ loop_id: "iter", loop_index: 0 });
  });

  test("loop_context names the enclosing loop and the emulated iteration", async () => {
    const toolCtx = makeCtxWithDraft(loopDraftSteps());
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression: "{ 'name': $item.name, 'idx': $loop_index }",
      step_id: "shape",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      value: { name: string; idx: number };
      metadata: { loop_context?: { loop_id: string; loop_index: number } };
    };
    expect(data.value).toEqual({ name: "Ada", idx: 0 });
    expect(data.metadata.loop_context).toEqual({ loop_id: "iter", loop_index: 0 });
  });

  test("a bare iteration name does NOT resolve (execution parity)", async () => {
    const toolCtx = makeCtxWithDraft(loopDraftSteps());
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression: "row.name",
      step_id: "shape",
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { value: unknown };
    expect(data.value === null || data.value === undefined).toBe(true);
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
