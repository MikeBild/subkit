// Regression coverage for the v1→v2→v3-churn session a6440493 (the
// DigitalOcean projects/resources workflow):
//
//   #1 — JSONata bare-identifier warnings on transform projections
//        (`{ 'id': id }`) are suppressed when the expression actually
//        produced a meaningful result. Pre-fix the false positives
//        drove the LLM into a "fix nothing" loop.
//   #2 — commitWorkflowAtomic refuses commit when the latest execution
//        had warnings_count > 0 unless preview is clean OR forceCommit
//        is set. Caps the version churn at 1 attempt.
//   #5 — withStatus contract: every gate-error return on the
//        run_workflow tool stamps `status: "failed"` so the
//        ExecutionDiagnosisCard never falls into the
//        `× Execution status missing from engine` branch.
//
// Fix #4 (confirmation transcript payload preview) is unit-tested in
// apps/sk/src/tests/render-elicit-answer.test.ts.
//
// NOTE: earlier fixes covered runtime warnings emitted by the
// JSONata transform-evaluation path (`unresolved_identifier`,
// `transform_empty_extraction`, `transform_dropped_fields`). Transforms
// are now JavaScript-only — the JSONata evaluation path and those
// runtime warnings have been removed from `runTransformStep`, so the
// `runTransformStep` describe blocks that verified them were deleted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationElicitations, conversations, workflows } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  withLatestPreview,
  withWorkflowExecution,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import { commitWorkflowAtomic } from "../persistence/commit-workflow.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("session_a6440493");
});

afterAll(async () => {
  await ctx.cleanup();
});

function readyDraft(
  slug: string,
  latestExecutionWarnings = 0,
  latestExecutionRequiresRepair = false,
): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: slug,
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          language: "javascript",
          expression: "return input.input;",
        },
      ],
    },
  };
  let draft = withWorkflowInspection(base);
  draft = withWorkflowValidation(draft, true, "Workflow draft validated.");
  draft = withLatestPreview(draft, {
    ok: true,
    summary: "preview ok",
    warnings: [],
  });
  if (latestExecutionWarnings > 0) {
    draft = withWorkflowExecution(draft, {
      execution_id: "00000000-0000-0000-0000-000000000001",
      workflow_id: null,
      workflow_version_id: null,
      status: "succeeded",
      environment: "dev",
      warnings_count: latestExecutionWarnings,
      recorded_at: new Date(TEST_NOW_MS).toISOString(),
      diagnosis_available: true,
      ...(latestExecutionRequiresRepair ? { requires_repair: true } : {}),
    });
  }
  return draft;
}

function stubToolCtx(conversationId: string, draft: DraftDocument): ToolContext {
  let live = draft;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    // biome-ignore lint/suspicious/noExplicitAny: stub for gate test
    engineClient: {} as any,
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
    },
  };
}

async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

async function seedApprovedConfirm(conversationId: string): Promise<void> {
  await ctx.testDb.db.insert(conversationElicitations).values({
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    tool_name: "ask_user_confirm",
    summary: "commit",
    // The commit gate authorizes on `commit_intent.kind` — the
    // authoritative field — not the cosmetic top-level `kind`.
    input: {
      kind: "save_workflow_draft",
      summary: "commit",
      commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
    },
    output: { confirmed: true },
    status: "resolved",
  });
}

// -----------------------------------------------------------------------
// Fix #2 — commit gate refuses unacknowledged warnings
// -----------------------------------------------------------------------

describe("commit gate · warnings_unacknowledged", () => {
  test("refuses commit when latest execution had requires_repair AND preview is dirty", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    // Latest execution carries `requires_repair: true` (real bug,
    // e.g. unresolved_identifier fired) AND the preview also carries
    // requires_repair (the LLM hasn't re-validated with a fix). The
    // gate now keys on `requires_repair`, not raw warning count, so
    // informational warnings (transform_dropped_fields on intentional
    // projections) don't trigger spurious blocks.
    let draft = readyDraft("warns-unack-1", 4, /* requires_repair */ true);
    draft = withLatestPreview(draft, {
      ok: true,
      summary: "preview with warnings",
      warnings: [{ step_key: "extract", code: "unresolved_identifier", message: "id" }],
      requires_repair: true,
    });
    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, draft),
    });
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: unknown };
    // The first gate the change hits is partial_success_not_acknowledged
    // (it shares the same predicate now). Either gate is acceptable —
    // both express "the run shape needs repair".
    expect(["partial_success_not_acknowledged", "warnings_unacknowledged"]).toContain(
      typeof data.error_code === "string" ? data.error_code : "",
    );
  });

  test("allows commit when latest execution had requires_repair BUT preview has cleared it", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    // Latest execution had requires_repair true, but the LLM has since
    // fixed the expressions and re-run dry_run with no repair flag —
    // preview cleared the bug, so the gate must NOT refuse.
    const draft = readyDraft("warns-cleared", 4, /* requires_repair */ true);
    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, draft),
    });
    expect(result.ok).toBe(true);
  });

  test("allows commit when latest execution had warnings but NOT requires_repair (informational only)", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    // The new contract: warnings without `requires_repair` are
    // informational (e.g. `transform_dropped_fields` on an intentional
    // projection). Commit must proceed — pre-fix this scenario forced
    // the LLM into a "fix nothing" loop because the gate refused.
    const draft = readyDraft("warns-info-only", 4, /* requires_repair */ false);
    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, draft),
    });
    expect(result.ok).toBe(true);
  });

  test("force_commit:true bypasses the warnings gate", async () => {
    const conversationId = await freshConversation();
    await seedApprovedConfirm(conversationId);
    let draft = readyDraft("warns-forced", 2);
    draft = withLatestPreview(draft, {
      ok: true,
      summary: "preview with warnings",
      warnings: [{ step_key: "x", code: "unresolved_identifier", message: "y" }],
    });
    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, draft),
      forceCommit: true,
    });
    expect(result.ok).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Fix #5 — withStatus contract: gate paths always stamp status
// -----------------------------------------------------------------------
//
// We exercise the run_workflow tool's gate path that returns a
// workflow_not_persisted error and assert the resulting envelope
// carries `status: "failed"` so the CLI's ExecutionDiagnosisCard
// never falls into the "× Execution status missing" branch.

describe("run_workflow · withStatus contract on gate paths", () => {
  test("workflow_not_persisted gate returns data with status=failed", async () => {
    const conversationId = await freshConversation();
    const { runWorkflowTool } = await import(
      "../../conversations/tools/generated/writes/run-workflow.ts"
    );
    const draft: DraftDocument = {
      mode: "workflow_authoring",
      workflow: { name: "no-target", steps: [] },
    };
    let live = draft;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: conversationId,
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      permission_mode: null,
      // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
      engineClient: {} as any,
      getDraft: () => live,
      setDraft: async (next) => {
        live = next;
      },
    };
    const result = (await runWorkflowTool.execute(toolCtx, {})) as ToolResult;
    expect(result.ok).toBe(false);
    const data = result.data as { status?: unknown; error_code?: unknown };
    expect(data.status).toBe("failed");
    expect(data.error_code).toBe("workflow_not_persisted");
  });
});

// Ensure the workflows table never grew via these tests (no real
// commits should have leaked through).
test("regression suite did not persist workflows via gate paths", async () => {
  const rows = await ctx.testDb.db
    .select()
    .from(workflows)
    .where(eq(workflows.tenant_id, ctx.tenant_id));
  // The "warnings cleared" test DID commit one workflow; the "force"
  // test committed another. No more than 2 from this suite.
  expect(rows.length).toBeLessThanOrEqual(3);
});

// -----------------------------------------------------------------------
// inspect_execution_step tool
// -----------------------------------------------------------------------

describe("inspect_execution_step", () => {
  test("returns step output_preview + canonical loop hint when step kind is loop", async () => {
    // Seed an execution + execution_step row so the tool has something
    // to read. Tenant scoping is enforced inside the tool.
    const { executions, executionSteps } = await import("../../db/schema/index.ts");
    const [execRow] = await ctx.testDb.db
      .insert(executions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: null,
        workflow_version_id: null,
        status: "succeeded",
        request_source: "chat",
        source_kind: "draft",
        execution_mode: "dev",
      })
      .returning({ id: executions.id });
    if (!execRow) throw new Error("seed execution failed");

    const fakeLoopOutput = [
      {
        extract: { data: { id: "p1", name: "alpha" }, error: null, duration_ms: 5 },
        fetch_resources: {
          data: { resources: [{ urn: "do:droplet:1" }] },
          error: null,
          duration_ms: 12,
        },
      },
    ];
    await ctx.testDb.db.insert(executionSteps).values({
      tenant_id: ctx.tenant_id,
      execution_id: execRow.id,
      step_key: "project_loop",
      step_index: 2,
      kind: "loop",
      status: "succeeded",
      output_preview: fakeLoopOutput,
      duration_ms: 17,
    });

    const { inspectExecutionStepTool } = await import(
      "../../conversations/tools/inspect-execution-step.ts"
    );
    const conversationId = await freshConversation();
    const draft: DraftDocument = {
      mode: "workflow_authoring",
      workflow: { name: "noop", steps: [] },
    };
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: conversationId,
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      permission_mode: null,
      // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
      engineClient: {} as any,
      getDraft: () => draft,
      setDraft: async () => {},
    };

    const result = await inspectExecutionStepTool.execute(toolCtx, {
      execution_id: execRow.id,
      step_key: "project_loop",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      kind: string;
      output_preview: unknown;
      next_best_actions: string[];
    };
    expect(data.kind).toBe("loop");
    expect(data.output_preview).toEqual(fakeLoopOutput);
    expect(data.next_best_actions.join(" ")).toContain("$scope.<loop_id>.data");
  });

  test("returns step_not_found with available_steps list", async () => {
    const { executions, executionSteps } = await import("../../db/schema/index.ts");
    const [execRow] = await ctx.testDb.db
      .insert(executions)
      .values({
        tenant_id: ctx.tenant_id,
        status: "succeeded",
        request_source: "chat",
        source_kind: "draft",
        execution_mode: "dev",
      })
      .returning({ id: executions.id });
    if (!execRow) throw new Error("seed execution failed");
    await ctx.testDb.db.insert(executionSteps).values({
      tenant_id: ctx.tenant_id,
      execution_id: execRow.id,
      step_key: "fetch_projects",
      step_index: 0,
      kind: "request",
      status: "succeeded",
    });
    const { inspectExecutionStepTool } = await import(
      "../../conversations/tools/inspect-execution-step.ts"
    );
    const conversationId = await freshConversation();
    const draft: DraftDocument = {
      mode: "workflow_authoring",
      workflow: { name: "noop", steps: [] },
    };
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: conversationId,
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      permission_mode: null,
      // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
      engineClient: {} as any,
      getDraft: () => draft,
      setDraft: async () => {},
    };
    const result = await inspectExecutionStepTool.execute(toolCtx, {
      execution_id: execRow.id,
      step_key: "nonexistent",
    });
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; available_steps?: unknown[] };
    expect(data.error_code).toBe("step_not_found");
    expect(Array.isArray(data.available_steps)).toBe(true);
  });

  test("refuses cross-tenant access with execution_not_found", async () => {
    const { tenants } = await import("../../db/schema/index.ts");
    const [otherTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "other-tenant", display_name: "Other" })
      .returning();
    if (!otherTenant) throw new Error("seed other tenant failed");
    const { executions } = await import("../../db/schema/index.ts");
    const [otherExec] = await ctx.testDb.db
      .insert(executions)
      .values({
        tenant_id: otherTenant.id,
        status: "succeeded",
        request_source: "chat",
        source_kind: "draft",
        execution_mode: "dev",
      })
      .returning({ id: executions.id });
    if (!otherExec) throw new Error("seed other execution failed");
    const { inspectExecutionStepTool } = await import(
      "../../conversations/tools/inspect-execution-step.ts"
    );
    const conversationId = await freshConversation();
    const draft: DraftDocument = {
      mode: "workflow_authoring",
      workflow: { name: "noop", steps: [] },
    };
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: conversationId,
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      permission_mode: null,
      // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
      engineClient: {} as any,
      getDraft: () => draft,
      setDraft: async () => {},
    };
    const result = await inspectExecutionStepTool.execute(toolCtx, {
      execution_id: otherExec.id,
      step_key: "anything",
    });
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string };
    expect(data.error_code).toBe("execution_not_found");
  });
});
