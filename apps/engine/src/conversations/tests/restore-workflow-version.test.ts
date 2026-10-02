// `restore_workflow_version` — the recovery move that was missing.
//
// A bad save reached production twice. The session that found the damage could
// describe it precisely and could not undo it: the capability existed at
// `POST /v1/workflows/{id}/restore/{version}` and nowhere in the tool palette.
// So it reached for an HTTP connector aimed at the engine's own API — leaving
// per-tool RBAC, the confirm gate and the commit-intent audit behind to do
// something entirely legitimate. The fix is not to police that detour but to
// remove the reason for it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { workflowVersions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createWorkflow, getWorkflow, updateWorkflow } from "../../workflows/service.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
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

const STEP_V1 = [{ id: "a", kind: "transform", language: "javascript", expression: "return 1;" }];
const STEP_V2 = [{ id: "b", kind: "transform", language: "javascript", expression: "return 2;" }];

describe("restore_workflow_version", () => {
  test("brings back the named version's content as the new active version", async () => {
    const created = await createWorkflow(
      {
        tenant_id: ctx.tenant_id,
        def: { name: "restore-me", slug: "restore-me", steps: STEP_V1 },
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    if (!created.workflow) throw new Error(`seed failed: ${created.errors?.join(", ")}`);
    const updated = await updateWorkflow(
      {
        tenant_id: ctx.tenant_id,
        id: created.workflow.id,
        def: { name: "restore-me", slug: "restore-me", steps: STEP_V2 },
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

    // The proof is the stored definition, not the envelope's own claim: a
    // restore that returns a cheerful message while leaving v2 live would be
    // the same class of lie this whole change is about.
    const live = await getWorkflow(ctx.tenant_id, created.workflow.id, ctx.testDb.db);
    if (!live) throw new Error("workflow vanished after restore");
    expect((live.steps as Array<{ id: string }>)[0]?.id).toBe("a");
    // History is kept, not rewound — the restore lands as a NEW version.
    expect(live.current_version).toBe(3);
  });

  test("an unknown version is a typed refusal, not a crash", async () => {
    const created = await createWorkflow(
      {
        tenant_id: ctx.tenant_id,
        def: { name: "only-one", slug: "only-one", steps: STEP_V1 },
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
        def: { name: "stored-earlier", slug: "stored-earlier", steps: STEP_V1 },
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    if (!created.workflow) throw new Error(`seed failed: ${created.errors?.join(", ")}`);
    // A version as an earlier engine stored it: `jsonata` is no longer a
    // transform language. Inserted directly, because today's write path would
    // refuse the definition.
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

    // Refused before any write: the live definition is still version 1.
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
    // Restoring replaces what is LIVE. If `auto` could clear it, the tool would
    // reintroduce the hole it was built to close, from the other direction.
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
