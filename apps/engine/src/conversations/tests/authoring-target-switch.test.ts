import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { loadDraft } from "../draft.ts";
import { authorWorkflowTool } from "../tools/author-workflow.ts";
import { editWorkflowPatchTool } from "../tools/edit-workflow-patch.ts";
import type { ToolContext } from "../tools/index.ts";
import { openWorkflowDraftTool } from "../tools/open-workflow-draft.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
let growthId = "";
let triageId = "";

const transform = (id: string, expression: string) => ({
  id,
  kind: "transform",
  language: "javascript",
  expression,
});

async function seedSaved(slug: string, steps: Array<Record<string, unknown>>): Promise<string> {
  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenant_id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: wf.id,
      version: 1,
      dag: { name: slug, slug, steps },
    })
    .returning();
  if (!version) throw new Error("seed version failed");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, wf.id));
  return wf.id;
}

async function openConversationFor(workflowId: string) {
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active", target_workflow_id: workflowId })
    .returning();
  if (!conv) throw new Error("conversation insert failed");
  let draft: DraftDocument = await loadDraft(ctx.tenant_id, conv.id, ctx.testDb.db);
  const toolCtx: ToolContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conv.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: workflowId,
    permission_mode: "auto",
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
  return { conversationId: conv.id, toolCtx, draft: () => draft };
}

async function targetOf(conversationId: string): Promise<string | null> {
  const [row] = await ctx.testDb.db
    .select({ target: conversations.target_workflow_id })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row?.target ?? null;
}

const errorOf = (data: unknown) =>
  data as { error_code: string; message: string; next_best_actions: string[] };

beforeAll(async () => {
  ctx = await createConversationTestCtx("authoring_target_switch");
  growthId = await seedSaved("mission-control-growth-weekly", [
    transform("fetch_report", "return { visits: 1 };"),
    transform("send_report", "return input.scope.fetch_report;"),
  ]);
  triageId = await seedSaved("watchkit-finding-triage", [
    transform("classify", "return { severity: 'low' };"),
    transform("send_email", "return input.scope.classify;"),
  ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
  getMockProvider().generateOverrides.generate = () => {
    throw new Error("no definition may be generated for an existing workflow");
  };
});

describe("the draft names and verifies the workflow it belongs to", () => {
  test("a patch meant for another workflow is refused and changes nothing", async () => {
    const { toolCtx, draft } = await openConversationFor(growthId);
    const before = JSON.stringify(draft().workflow);
    const result = await editWorkflowPatchTool.execute(toolCtx, {
      workflow: "watchkit-finding-triage",
      step_patches: [{ step_id: "send_email", op: "replace", path: "/expression", value: "1" }],
    });
    expect(result.ok).toBe(false);
    const data = errorOf(result.data);
    expect(data.error_code).toBe("draft_target_mismatch");
    expect(data.message).toContain("mission-control-growth-weekly");
    expect(data.next_best_actions).toEqual(["open_workflow_draft"]);
    expect(JSON.stringify(draft().workflow)).toBe(before);
  });

  test("a patch for the draft's workflow lands and the result names that workflow", async () => {
    const { toolCtx } = await openConversationFor(growthId);
    const result = await editWorkflowPatchTool.execute(toolCtx, {
      workflow: "mission-control-growth-weekly",
      step_patches: [
        {
          step_id: "fetch_report",
          op: "replace",
          path: "/expression",
          value: "return { visits: 2 };",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect((result.data as { target: unknown }).target).toMatchObject({
      workflow_id: growthId,
      slug: "mission-control-growth-weekly",
    });
  });

  test("an unknown step id says which workflow's draft was searched", async () => {
    const { toolCtx } = await openConversationFor(growthId);
    const result = await editWorkflowPatchTool.execute(toolCtx, {
      step_patches: [{ step_id: "send_email", op: "replace", path: "/expression", value: "1" }],
    });
    const data = errorOf(result.data);
    expect(data.error_code).toBe("patch_target_invalid");
    expect(data.message).toContain("mission-control-growth-weekly");
    expect(data.next_best_actions).toContain("open_workflow_draft");
  });
});

describe("author_workflow never regenerates a saved workflow", () => {
  test("the slug of another saved workflow is refused and the binding survives", async () => {
    const { conversationId, toolCtx, draft } = await openConversationFor(growthId);
    const before = JSON.stringify(draft().workflow);
    const result = await authorWorkflowTool.execute(toolCtx, {
      goal: "triage the findings and email them",
      slug: "watchkit-finding-triage",
    });
    expect(result.ok).toBe(false);
    const data = errorOf(result.data);
    expect(data.error_code).toBe("workflow_already_exists");
    expect(data.next_best_actions).toContain("open_workflow_draft");
    expect(getMockProvider().calls.filter((c) => c.flow === "generate")).toHaveLength(0);
    expect(await targetOf(conversationId)).toBe(growthId);
    expect(JSON.stringify(draft().workflow)).toBe(before);
  });
});

describe("author_workflow next to an archived workflow", () => {
  test("an archived workflow keeps its slug and a new draft takes the next free one", async () => {
    await ctx.testDb.db
      .update(workflows)
      .set({ lifecycle: "archived" })
      .where(eq(workflows.slug, "watchkit-finding-triage"));
    const { toolCtx, draft } = await openConversationFor(growthId);
    getMockProvider().generateOverrides.generate = () => ({
      name: "Finding triage",
      slug: "watchkit-finding-triage",
      steps: [{ id: "s", kind: "transform", language: "javascript", expression: "return {};" }],
    });
    const result = await authorWorkflowTool.execute(toolCtx, {
      goal: "triage the findings",
      slug: "watchkit-finding-triage",
    });
    expect(result.ok).toBe(true);
    expect(draft().workflow?.slug).toBe("watchkit-finding-triage-2");
    await ctx.testDb.db
      .update(workflows)
      .set({ lifecycle: "active" })
      .where(eq(workflows.slug, "watchkit-finding-triage"));
  });
});

describe("author_workflow for a new slug in a bound conversation", () => {
  test("the new draft no longer carries the saved workflow's identity", async () => {
    const { conversationId, toolCtx, draft } = await openConversationFor(growthId);
    getMockProvider().generateOverrides.generate = () => ({
      name: "Brand new report",
      slug: "brand-new-report",
      steps: [
        transform("collect", "return { n: 1 };"),
        transform("shape", "return input.scope.collect;"),
      ],
    });
    const result = await authorWorkflowTool.execute(toolCtx, {
      goal: "a separate weekly brand report",
      slug: "brand-new-report",
    });
    expect(result.ok).toBe(true);
    expect(await targetOf(conversationId)).toBeNull();
    expect(toolCtx.workflow_id).toBeNull();
    expect(draft().summary?.persisted_resources.some((r) => r.id === growthId)).toBe(false);
    expect(draft().workflow.slug).toBe("brand-new-report");
    expect((draft().workflow as { goal?: string }).goal).toBe("a separate weekly brand report");
  });
});

describe("open_workflow_draft switches the draft from the saved definition", () => {
  test("opens another saved workflow, rebinds the conversation, and patches land on it", async () => {
    const { conversationId, toolCtx, draft } = await openConversationFor(growthId);
    const opened = await openWorkflowDraftTool.execute(toolCtx, {
      workflow: "watchkit-finding-triage",
    });
    expect(opened.ok).toBe(true);
    expect((opened.data as { step_ids: string[] }).step_ids).toEqual(["classify", "send_email"]);
    expect(draft().workflow.slug).toBe("watchkit-finding-triage");
    expect(draft().summary?.active_target.id).toBe(triageId);
    expect(draft().summary?.persisted_resources.map((r) => r.id)).toEqual([triageId]);
    expect(toolCtx.workflow_id).toBe(triageId);
    expect(await targetOf(conversationId)).toBe(triageId);

    const patched = await editWorkflowPatchTool.execute(toolCtx, {
      workflow: "watchkit-finding-triage",
      step_patches: [
        {
          step_id: "send_email",
          op: "replace",
          path: "/expression",
          value: "return { sent: input.scope.classify };",
        },
      ],
    });
    expect(patched.ok).toBe(true);
  });

  test("unsaved changes block the switch until the person agrees to drop them", async () => {
    const { toolCtx, draft } = await openConversationFor(growthId);
    const edited = await editWorkflowPatchTool.execute(toolCtx, {
      workflow: "mission-control-growth-weekly",
      step_patches: [
        { step_id: "send_report", op: "replace", path: "/expression", value: "return 3;" },
      ],
    });
    expect(edited.ok).toBe(true);
    const refused = await openWorkflowDraftTool.execute(toolCtx, {
      workflow: "watchkit-finding-triage",
    });
    expect(refused.ok).toBe(false);
    expect(errorOf(refused.data).error_code).toBe("draft_has_unsaved_changes");
    expect(draft().workflow.slug).toBe("mission-control-growth-weekly");

    const switched = await openWorkflowDraftTool.execute(toolCtx, {
      workflow: "watchkit-finding-triage",
      discard_unsaved: true,
    });
    expect(switched.ok).toBe(true);
    expect(draft().workflow.slug).toBe("watchkit-finding-triage");
  });

  test("an unknown workflow is workflow_not_found", async () => {
    const { toolCtx } = await openConversationFor(growthId);
    const result = await openWorkflowDraftTool.execute(toolCtx, { workflow: "no-such-flow" });
    expect(errorOf(result.data).error_code).toBe("workflow_not_found");
  });
});
