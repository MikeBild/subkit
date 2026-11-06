import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { workflowVersions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createWorkflow, getWorkflow, updateWorkflow } from "../../workflows/service.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import { decideToolMode } from "../tool-policies.ts";
import type { ToolContext } from "../tools/index.ts";
import { restoreWorkflowVersionTool } from "../tools/restore-workflow-version.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const nextUuid = createDeterministicUuidFactory(0xfa5_70e);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("restore_wf_version");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(): ToolContext {
  const draft = createEmptyDraftDocument();
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: nextUuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async () => {},
  };
}

const ORIGINAL_STEPS = [
  { id: "a", kind: "transform", language: "javascript", expression: "return 1;" },
];
const REPLACEMENT_STEPS = [
  { id: "b", kind: "transform", language: "javascript", expression: "return 2;" },
];

describe("restore_workflow_version", () => {
  test("brings back the named version's content as the new active version", async () => {
    const created = await createWorkflow(
      {
        tenant_id: ctx.tenant_id,
        def: { name: "restore-me", slug: "restore-me", steps: ORIGINAL_STEPS },
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    if (!created.workflow) throw new Error(`seed failed: ${created.errors?.join(", ")}`);
    const updated = await updateWorkflow(
      {
        tenant_id: ctx.tenant_id,
        id: created.workflow.id,
        def: { name: "restore-me", slug: "restore-me", steps: REPLACEMENT_STEPS },
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    if (!updated.workflow) throw new Error(`update failed: ${updated.errors?.join(", ")}`);

    const result = await restoreWorkflowVersionTool.execute(makeCtx(), {
      slug: "restore-me",
      version: 1,
    });
    expect(result.ok).toBe(true);

    const live = await getWorkflow(ctx.tenant_id, created.workflow.id, ctx.testDb.db);
    if (!live) throw new Error("workflow vanished after restore");
    expect((live.steps as Array<{ id: string }>)[0]?.id).toBe("a");
    expect(live.current_version).toBe(3);
  });

  test("an unknown version is a typed refusal, not a crash", async () => {
    const created = await createWorkflow(
      {
        tenant_id: ctx.tenant_id,
        def: { name: "only-one", slug: "only-one", steps: ORIGINAL_STEPS },
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    if (!created.workflow) throw new Error(`seed failed: ${created.errors?.join(", ")}`);
    const result = await restoreWorkflowVersionTool.execute(makeCtx(), {
      workflow_id: created.workflow.id,
      version: 99,
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error_code?: string }).error_code).toBe("workflow_version_not_found");
  });

  test("a version that no longer validates is a typed refusal naming the step", async () => {
    const created = await createWorkflow(
      {
        tenant_id: ctx.tenant_id,
        def: { name: "stored-earlier", slug: "stored-earlier", steps: ORIGINAL_STEPS },
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    if (!created.workflow) throw new Error(`seed failed: ${created.errors?.join(", ")}`);
    await ctx.testDb.db.insert(workflowVersions).values({
      tenant_id: ctx.tenant_id,
      workflow_id: created.workflow.id,
      version: 2,
      dag: {
        name: "stored-earlier",
        slug: "stored-earlier",
        steps: [{ id: "shape", kind: "transform", language: "jsonata", expression: "$.items" }],
      },
    });

    const result = await restoreWorkflowVersionTool.execute(makeCtx(), {
      workflow_id: created.workflow.id,
      version: 2,
    });
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; message?: string };
    expect(data.error_code).toBe("version_not_restorable");
    expect(data.message).toContain('step "shape"');

    const live = await getWorkflow(ctx.tenant_id, created.workflow.id, ctx.testDb.db);
    if (!live) throw new Error("workflow vanished after refused restore");
    expect(live.current_version).toBe(1);
    expect((live.steps as Array<{ id: string }>)[0]?.id).toBe("a");
  });

  test("an unknown slug is a typed refusal", async () => {
    const result = await restoreWorkflowVersionTool.execute(makeCtx(), {
      slug: "no-such-workflow-anywhere",
      version: 1,
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error_code?: string }).error_code).toBe("workflow_not_found");
  });

  test("permission_mode auto cannot short-circuit it", async () => {
    const decision = decideToolMode({
      tool: "restore_workflow_version",
      category: "tenant_write",
      input: { slug: "restore-me", version: 1 },
      permission_mode: "auto",
      overrides: {},
    });
    expect(decision.mode).toBe("confirm_before_execution");
  });
});
