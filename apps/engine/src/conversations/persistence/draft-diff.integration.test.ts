// Workflow-edit verb hygiene + honest conversation_commit.
//
// Covers the shared `classifyDraftVsPersisted` predicate and its two consumers:
//   - RC2: conversation_commit reports honestly (error when the draft has
//     uncommitted STEP edits, success when clean).
//   - B3: update_workflow refuses a structural-dirty draft (anti silent
//     step-loss) but allows a metadata edit on a clean/committed draft.
//   - B2: an approved confirm carrying commit_intent{kind:update_workflow_metadata}
//     auto-persists the description via the update_workflow tool.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  conversationElicitations,
  conversations,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { handleConversationTool } from "../../mcp/capabilities/conversations.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import {
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import { appendSnapshot } from "../draft.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import { updateWorkflowTool } from "../tools/generated/writes/update-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { maybeAutoPersistFromElicitation } from "./auto-persist.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";
import { classifyDraftVsPersisted } from "./draft-diff.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("draft_diff");
});

afterAll(async () => {
  await ctx.cleanup();
});

function draftWith(slug: string, expression: string): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: slug,
      slug,
      steps: [{ id: "echo", kind: "transform", expression, language: "javascript" }],
    },
  };
  let draft = withWorkflowInspection(base);
  draft = withWorkflowValidation(draft, true, "Workflow draft validated.");
  draft = withLatestPreview(draft, { ok: true, summary: "preview ok", warnings: [] });
  return draft;
}

const cleanDraft = (slug: string) => draftWith(slug, "return input.input;");
const dirtyDraft = (slug: string) => draftWith(slug, "return { changed: true };");

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
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
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

/** Commit a clean workflow. Returns its id and the post-commit BOUND draft
 *  (carries the `persisted_resources` ref, so a later in-place edit survives
 *  loadDraft's bound-workflow hydration instead of being clobbered clean). */
async function seedCommittedWorkflow(
  conversationId: string,
  slug: string,
): Promise<{ workflowId: string; boundDraft: DraftDocument }> {
  const toolCtx = stubToolCtx(conversationId, cleanDraft(slug));
  const res = await commitWorkflowAtomic({ ctx: toolCtx, skipPriorApprovalCheck: true });
  expect(res.ok).toBe(true);
  return {
    workflowId: (res.data as { workflow_id: string }).workflow_id,
    boundDraft: toolCtx.getDraft(),
  };
}

describe("classifyDraftVsPersisted", () => {
  test("clean draft → clean; changed step → structural; null/empty target → no_target", async () => {
    const convId = await freshConversation();
    const { workflowId } = await seedCommittedWorkflow(convId, "wf-classify");
    const { db, tenant_id } = { db: ctx.testDb.db, tenant_id: ctx.tenant_id };

    expect(
      await classifyDraftVsPersisted(db, tenant_id, cleanDraft("wf-classify"), workflowId),
    ).toEqual({ state: "clean" });
    expect(
      await classifyDraftVsPersisted(db, tenant_id, dirtyDraft("wf-classify"), workflowId),
    ).toEqual({ state: "structural" });
    expect(await classifyDraftVsPersisted(db, tenant_id, cleanDraft("wf-classify"), null)).toEqual({
      state: "no_target",
      reason: "unbound",
    });
    const emptyDraft: DraftDocument = {
      mode: "workflow_authoring",
      workflow: { name: "x", steps: [] },
    };
    expect(await classifyDraftVsPersisted(db, tenant_id, emptyDraft, workflowId)).toEqual({
      state: "no_target",
      reason: "empty_draft",
    });
  });

  test("missing current version → no_persisted_version; corrupt dag → unreadable_dag", async () => {
    const convId = await freshConversation();
    const { workflowId } = await seedCommittedWorkflow(convId, "wf-classify-reason");
    const { db, tenant_id } = { db: ctx.testDb.db, tenant_id: ctx.tenant_id };

    // Corrupt the persisted dag: a version row exists but fails schema parse.
    await db
      .update(workflowVersions)
      .set({ dag: { not_a: "workflow" } })
      .where(eq(workflowVersions.workflow_id, workflowId));
    expect(
      await classifyDraftVsPersisted(db, tenant_id, cleanDraft("wf-classify-reason"), workflowId),
    ).toEqual({ state: "no_target", reason: "unreadable_dag" });

    // Detach the current version pointer entirely.
    await db
      .update(workflows)
      .set({ current_version_id: null, draft_version_id: null })
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflowId)));
    expect(
      await classifyDraftVsPersisted(db, tenant_id, cleanDraft("wf-classify-reason"), workflowId),
    ).toEqual({ state: "no_target", reason: "no_persisted_version" });
  });
});

describe("B3 — update_workflow refuses structural-dirty drafts", () => {
  test("dirty step draft → uncommitted_step_edits refusal (no metadata write)", async () => {
    const convId = await freshConversation();
    const { workflowId } = await seedCommittedWorkflow(convId, "wf-b3");
    const toolCtx = stubToolCtx(convId, dirtyDraft("wf-b3"));

    const res = await updateWorkflowTool.execute(toolCtx, {
      id: workflowId,
      description: "should be blocked",
    });
    expect(res.ok).toBe(false);
    expect((res.data as { error?: string }).error).toBe("uncommitted_step_edits");
  });
});

describe("B2 — update_workflow_metadata commit_intent auto-persists the description", () => {
  test("approved confirm → description column updated via update_workflow", async () => {
    const convId = await freshConversation();
    const { workflowId } = await seedCommittedWorkflow(convId, "wf-b2");

    const input = {
      kind: "external_write",
      commit_intent: {
        kind: "update_workflow_metadata",
        payload: { id: workflowId, description: "B2 English description" },
        description: "set description",
      },
    };
    const [elic] = await ctx.testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id: convId,
        tool_name: "ask_user_confirm",
        summary: "Confirm update_workflow",
        input,
        output: { confirmed: true },
        status: "resolved",
      })
      .returning();

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id: ctx.tenant_id,
      conversation_id: convId,
      actor_id: ctx.user_id,
      elicitation_output: { confirmed: true },
      elicitation: { id: elic!.id, tool_name: elic!.tool_name, input },
      db: ctx.testDb.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("update_workflow");
    expect(dispatch.synthetic_result?.ok).toBe(true);

    const [row] = await ctx.testDb.db
      .select({ description: workflows.description })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflowId)));
    expect(row?.description).toBe("B2 English description");
  });
});

describe("RC2 — conversation_commit reports honestly", () => {
  function principal(): ResolvedPrincipal {
    return {
      kind: "user",
      id: ctx.user_id,
      tenant_id: ctx.tenant_id,
      provider: "api_key",
      roles: ["admin"],
    } as ResolvedPrincipal;
  }

  test("a replaced draft version is stale even when its definition is unchanged", async () => {
    const convId = await freshConversation();
    const { workflowId, boundDraft } = await seedCommittedWorkflow(convId, "wf-stale-draft-status");
    await appendSnapshot(ctx.tenant_id, convId, boundDraft, ctx.testDb.db);
    const bound = boundDraft.state?.persisted_resources.find(
      (resource) => resource.id === workflowId,
    );
    if (!bound?.draft_version_id) throw new Error("draft base missing");
    const replacement = await saveWorkflowDraft(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        workflow_id: workflowId,
        expected_draft_version_id: bound.draft_version_id,
        request_source: "api",
        def: boundDraft.workflow,
        scope_index: {
          echo: {
            available_paths: ["echo.data"],
            shape_summary: "new preview evidence",
            primary_data_path: "echo.data",
          },
        },
      },
      ctx.testDb.db,
    );
    if (!replacement.draft) throw new Error(replacement.errors.join("; "));
    expect(replacement.draft.version_id).not.toBe(bound.draft_version_id);
    expect(
      await classifyDraftVsPersisted(ctx.testDb.db, ctx.tenant_id, boundDraft, workflowId),
    ).toEqual({ state: "structural" });
    const reply = await handleConversationTool({
      db: ctx.testDb.db,
      principal: principal(),
      name: "conversation_commit",
      args: { conversation_id: convId },
    });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text ?? "").toContain("NOT COMMITTED");
  });

  test("clean committed draft → success echo; uncommitted step edits → NOT COMMITTED error", async () => {
    const convId = await freshConversation();
    const { boundDraft } = await seedCommittedWorkflow(convId, "wf-rc2");

    const ok = await handleConversationTool({
      db: ctx.testDb.db,
      principal: principal(),
      name: "conversation_commit",
      args: { conversation_id: convId },
    });
    expect(ok.isError).toBe(false);
    // Acceptance (#302): the reply is derived from the persisted rows — pin
    // response == persisted state after a REAL commit (commitWorkflowAtomic).
    const okBody = JSON.parse(ok.content[0]?.text ?? "{}") as {
      committed?: {
        workflow_version_id: string;
        version: number;
        steps_present: number;
        slug: string;
        updated_at: string;
      };
      draft_state?: string;
      verified_against_draft?: boolean;
    };
    const [wfRow] = await ctx.testDb.db
      .select({
        id: workflows.id,
        draft_version_id: workflows.draft_version_id,
        current_version_id: workflows.current_version_id,
        updated_at: workflows.updated_at,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, "wf-rc2"),
          isNull(workflows.deleted_at),
        ),
      );
    if (!wfRow?.draft_version_id) throw new Error("saved draft row missing");
    const [vRow] = await ctx.testDb.db
      .select({ version: workflowVersions.version, dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, ctx.tenant_id),
          eq(workflowVersions.workflow_id, wfRow.id),
          eq(workflowVersions.id, wfRow.draft_version_id),
        ),
      );
    expect(okBody.committed?.workflow_version_id).toBe(wfRow.draft_version_id);
    expect(okBody).toMatchObject({
      persistence_kind: "draft",
      activation_required: true,
      current_version_id: null,
    });
    expect(okBody).not.toHaveProperty("usage");
    expect(wfRow.current_version_id).toBeNull();
    expect(okBody.committed?.version).toBe(vRow?.version ?? -1);
    expect(okBody.committed?.steps_present).toBe(
      ((vRow!.dag as { steps?: unknown[] })?.steps ?? []).length,
    );
    expect(okBody.committed?.slug).toBe("wf-rc2");
    expect(okBody.committed?.updated_at).toBe(wfRow.updated_at.toISOString());
    expect(okBody.draft_state).toBe("clean");
    expect(okBody.verified_against_draft).toBe(true);

    // Make the working draft diverge from the live version (uncommitted step
    // edit). Derive from the BOUND draft so it keeps `persisted_resources` and
    // survives loadDraft's bound-workflow hydration (an unbound dirty draft
    // would be re-hydrated clean).
    const dirtyBound = withWorkflowDraft(boundDraft, {
      ...boundDraft.workflow!,
      steps: [
        {
          id: "echo",
          kind: "transform",
          expression: "return { changed: true };",
          language: "javascript",
        },
      ],
    });
    await appendSnapshot(ctx.tenant_id, convId, dirtyBound, ctx.testDb.db);

    const dirty = await handleConversationTool({
      db: ctx.testDb.db,
      principal: principal(),
      name: "conversation_commit",
      args: { conversation_id: convId },
    });
    expect(dirty.isError).toBe(true);
    expect(dirty.content[0]?.text ?? "").toContain("NOT COMMITTED");
  });

  // Clean workflows live behind the same slug → exactly one row (no churn from the metadata write).
  test("metadata write did not fork the workflow row", async () => {
    const rows = await ctx.testDb.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, "wf-b2"),
          isNull(workflows.deleted_at),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
