// Bug QQ regression: the commit gate must distinguish informational
// warnings (transform_dropped_fields on an intentional projection) from
// real bugs (requires_repair: true). Pre-fix the gate counted ANY
// warning as "unacknowledged" and refused auto-persist, forcing the
// LLM to re-issue commit_draft manually — producing the misleading
// `audit approval.approved result:denied reason:auto_persist_on_confirmation`
// row plus a fragile recovery path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import {
  withLatestPreview,
  withWorkflowExecution,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import { commitDraftTool } from "../tools/commit-draft.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("commit-gate-requires-repair");
});
afterAll(async () => {
  await ctx.cleanup();
});

function toolCtx(
  tenantId: string,
  conversationId: string,
  actorId: string,
  getDraft: () => DraftDocument,
): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: actorId,
    connector_id: null,
    workflow_id: null,
    // biome-ignore lint/suspicious/noExplicitAny: stub for gate test
    engineClient: {} as any,
    getDraft,
    setDraft: async () => {},
  };
}

async function seedApprovedConfirm(conversationId: string): Promise<void> {
  await ctx.testDb.db.insert(conversationElicitations).values({
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    tool_name: "ask_user_confirm",
    summary: "commit",
    input: { kind: "commit_draft", summary: "commit" },
    output: { confirmed: true },
    status: "resolved",
  });
}

let draftCounter = 0;
function makeDraft(opts: {
  executionRequiresRepair: boolean;
  previewRequiresRepair: boolean;
  warningsCount: number;
}): DraftDocument {
  // Single transform step — no connector required, so the validation
  // gate passes and the requires_repair gate is the next thing the
  // commit logic evaluates. Slug is unique per call so consecutive
  // tests don't trip the slug-conflict gate.
  draftCounter += 1;
  const slug = `gate-test-${draftCounter}`;
  const base: DraftDocument = {
    workflow: {
      name: slug,
      slug,
      steps: [{ id: "shape", kind: "transform", language: "jsonata", expression: "$input" }],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test fixture
  } as any;
  let next = withWorkflowInspection(base);
  next = withWorkflowValidation(next, true, "validated");
  next = withLatestPreview(
    next,
    {
      ok: true,
      step_id: "fetch",
      summary: "Ran 1 step",
      preview: [{ id: "p1" }],
      ...(opts.previewRequiresRepair ? { requires_repair: true } : {}),
    },
    "dry_run_workflow",
    "workflow_previewed",
  );
  next = withWorkflowExecution(next, {
    execution_id: "11111111-1111-1111-1111-111111111111",
    workflow_id: null,
    workflow_version_id: null,
    status: "succeeded",
    environment: "dev",
    warnings_count: opts.warningsCount,
    recorded_at: new Date().toISOString(),
    diagnosis_available: opts.warningsCount > 0,
    ...(opts.executionRequiresRepair ? { requires_repair: true } : {}),
  });
  return next;
}

describe("commit gate · requires_repair (Bug QQ)", () => {
  test("commit succeeds when execution requires_repair is FALSE even with warnings", async () => {
    // The session 16d6e46a scenario: run produced 2 informational
    // warnings (transform_dropped_fields), which we now classify as
    // NOT requiring repair. The gate should let auto-persist through.
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);
    const draft = makeDraft({
      executionRequiresRepair: false,
      previewRequiresRepair: false,
      warningsCount: 2,
    });
    const result = await commitDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );
    // Gate is open: any failure here is from downstream (e.g. the
    // commit-actually-runs path) — but the partial_success /
    // warnings_unacknowledged gates must NOT be the failure cause.
    if (!result.ok) {
      const data = result.data as { error_code?: string };
      expect(data.error_code).not.toBe("partial_success_not_acknowledged");
      expect(data.error_code).not.toBe("warnings_unacknowledged");
    }
  });

  test("commit refuses when execution requires_repair is TRUE and the latest preview has not cleared it", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);
    const draft = makeDraft({
      executionRequiresRepair: true,
      previewRequiresRepair: true,
      warningsCount: 1,
    });
    const result = await commitDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string };
    // First gate hit is the partial_success one — it has the same
    // require-repair predicate now and fires earlier.
    expect(["partial_success_not_acknowledged", "warnings_unacknowledged"]).toContain(
      data.error_code ?? "",
    );
  });

  test("commit succeeds when execution requires_repair is TRUE but a fresher preview has cleared it", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);
    const draft = makeDraft({
      executionRequiresRepair: true,
      previewRequiresRepair: false, // fresher preview cleared the flag
      warningsCount: 0,
    });
    const result = await commitDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );
    if (!result.ok) {
      const data = result.data as { error_code?: string };
      expect(data.error_code).not.toBe("partial_success_not_acknowledged");
      expect(data.error_code).not.toBe("warnings_unacknowledged");
    }
  });
});
