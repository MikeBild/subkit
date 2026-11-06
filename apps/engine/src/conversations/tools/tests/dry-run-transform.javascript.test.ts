import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { dryRunTransformTool } from "../dry-run-transform.ts";
import type { ToolContext } from "../index.ts";
import { recordLastPreview } from "../last-preview-store.ts";
import { ctx, makeCtx, tenant_id, useDryRunTransformSetup } from "./dry-run-transform-fixtures.ts";

useDryRunTransformSetup();

const nextActorId = createDeterministicUuidFactory(0xd9b4e6);

describe("dry_run_transform — javascript dialect", () => {
  beforeEach(() => {
    resetMockProvider();
  });

  function makeCtxWithDraft(steps: Array<Record<string, unknown>>): ToolContext {
    return {
      ...makeCtx(),
      getDraft: () => ({ workflow: { name: "wf", slug: "wf", steps } }),
    };
  }

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

  test("happy path: function body evaluates against the recorded scope with the production { scope, input } context", async () => {
    const toolCtx = makeCtx();
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression:
        "const names = input.scope.fetch.data.items.map((i) => i.name);\nreturn { names, since: input.input.since };",
      sample_data: "$scope",
      dialect: "javascript",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      value: { names: string[]; since: string };
      metadata: { dialect: string; resolved_from_preview?: string };
    };
    expect(data.value).toEqual({ names: ["Ada", "Grace"], since: "2026-01-01" });
    expect(data.metadata.dialect).toBe("javascript");
    expect(data.metadata.resolved_from_preview).toBe("$scope");
  });

  test("loop-body emulation: the body reads input.scope.$item / input.scope.$loop_index", async () => {
    const toolCtx = makeCtxWithDraft([
      { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
      {
        id: "iter",
        kind: "loop",
        over: "$scope.fetch.data.items",
        body: ["shape"],
      },
      { id: "shape", kind: "transform", language: "javascript", expression: "return null;" },
    ]);
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression:
        "return { name: input.scope.$item.name, idx: input.scope.$loop_index, total: input.scope.fetch.data.items.length, since: input.input.since };",
      step_id: "shape",
      dialect: "javascript",
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

  test("$item resolves and no bare item name is bound into input.scope", async () => {
    const toolCtx = makeCtxWithDraft([
      { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
      { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: ["shape"] },
      { id: "shape", kind: "transform", language: "javascript", expression: "return null;" },
    ]);
    recordEnvelopePreview(toolCtx);
    const result = await dryRunTransformTool.execute(toolCtx, {
      expression:
        'return { name: input.scope.$item.name, hasBare: Object.prototype.hasOwnProperty.call(input.scope, "row") };',
      step_id: "shape",
      dialect: "javascript",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      value: { name: string; hasBare: boolean };
    };
    expect(data.value).toEqual({ name: "Ada", hasBare: false });
  });

  test("syntax error classifies as compile_error and carries a verified JS repair (language passthrough)", async () => {
    const fixed = "const names = input.scope.fetch.data.items.map((i) => i.name);\nreturn names;";
    const prompts: string[] = [];
    getMockProvider().generateOverrides.repair = (last) => {
      prompts.push(last);
      return { expression: fixed, reasoning: "missing closing parenthesis" };
    };
    const bad = "const names = input.scope.fetch.data.items.map((i) => i.name;\nreturn names;";
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: bad,
      sample_data: { fetch: { data: { items: [{ name: "Ada" }] } } },
      dialect: "javascript",
    });
    expect(result.ok).toBe(false);
    const data = result.data as {
      error: { code: string; message: string };
      repair?: { repaired: boolean; before?: string; after?: string };
      metadata: { dialect: string };
    };
    expect(data.error.code).toBe("compile_error");
    expect(data.metadata.dialect).toBe("javascript");
    expect(data.repair?.repaired).toBe(true);
    expect(data.repair?.before).toBe(bad);
    expect(data.repair?.after).toBe(fixed);
    expect(prompts[0]).toContain("JavaScript transform");
    expect(prompts[0]).toContain("FUNCTION BODY");
  });

  test("throwing body classifies as eval_error", async () => {
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "return input.scope.fetch.data.items.map((i) => i.name);",
      sample_data: { fetch: { data: {} } },
      dialect: "javascript",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string } }).error;
    expect(err.code).toBe("eval_error");
  });

  test("empty result over a real scope gets a verified JS repair proposal", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "return input.scope.fetch.data.items;",
    });
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "return input.scope.fetch.data.wrong_field;",
      sample_data: { fetch: { data: { items: [{ name: "Ada" }] } } },
      dialect: "javascript",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      value: unknown;
      repair?: { repaired: boolean; after?: string };
    };
    expect(data.value === null || data.value === undefined).toBe(true);
    expect(data.repair?.repaired).toBe(true);
    expect(data.repair?.after).toBe("return input.scope.fetch.data.items;");
  });
});

describe("dry_run_transform — audit hygiene", () => {
  test("system-account principal is retained in the audit row", async () => {
    const systemAccountId = nextActorId();
    const toolCtx = {
      ...makeCtx(),
      actor_id: systemAccountId,
      principal: {
        kind: "system_account" as const,
        id: systemAccountId,
        tenant_id,
        provider: "test",
        roles: [],
      },
    };
    await dryRunTransformTool.execute(toolCtx, {
      expression: "value",
      sample_data: { value: true },
      dialect: "jsonata",
    });
    const [row] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "conversation.dry_run_transform"),
          eq(auditLog.resource_id, toolCtx.conversation_id),
        ),
      )
      .limit(1);
    expect(row).toEqual({ actor_type: "system_account", actor_id: systemAccountId });
  });

  test("ID-only legacy context remains unknown rather than being attributed to a user", async () => {
    const actor_id = nextActorId();
    const toolCtx = {
      ...makeCtx(),
      actor_id,
      engineClient: new EngineClient({ tenant_id, actor_id, db: ctx.db }),
    };
    await dryRunTransformTool.execute(toolCtx, {
      expression: "value",
      sample_data: { value: true },
      dialect: "jsonata",
    });
    const [row] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "conversation.dry_run_transform"),
          eq(auditLog.resource_id, toolCtx.conversation_id),
        ),
      )
      .limit(1);
    expect(row).toEqual({ actor_type: "unknown", actor_id: null });
  });

  test("audit metadata stores expression_hash, not raw expression", async () => {
    const expression = "items.{ 'id': id }";
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
    expect(JSON.stringify(row).includes(expression)).toBe(false);
  });
});
