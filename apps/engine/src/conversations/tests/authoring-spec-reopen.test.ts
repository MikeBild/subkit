import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import type { WorkflowSpec } from "../../workflows/draft-schemas.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import { loadDraft } from "../draft.ts";
import { workflowDefFromDraft } from "../persistence/commit-workflow.ts";
import { persistAuthoringWorkflowDraft } from "../persistence/persist-authoring-workflow-draft.ts";
import { authorWorkflowTool } from "../tools/author-workflow.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import { editWorkflowPatchTool } from "../tools/edit-workflow-patch.ts";
import type { ToolContext } from "../tools/index.ts";
import { openWorkflowDraftTool } from "../tools/open-workflow-draft.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

const transform = (id: string, expression: string) => ({
  id,
  kind: "transform",
  language: "javascript",
  expression,
});

function threeSteps(slug: string) {
  return {
    name: slug,
    slug,
    steps: [
      transform("load", "return { visits: 3 };"),
      transform("count", "return { total: input.scope.load.data.visits };"),
      transform("report", "return { summary: `visits: ${input.scope.count.data.total}` };"),
    ],
  };
}

function spec(goal: string): WorkflowSpec {
  return {
    goal,
    inputs: [],
    outputs: [{ name: "summary", description: "One line with the weekly visits" }],
    delivery: null,
    conventions_applied: [],
    evidence: [],
    open_questions: [],
    origin: "chat",
  };
}

async function openConversation() {
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning();
  if (!conv) throw new Error("conversation insert failed");
  let draft: DraftDocument = await loadDraft(ctx.tenant_id, conv.id, ctx.testDb.db);
  const toolCtx: ToolContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conv.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: "ask",
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
  return { toolCtx, draft: () => draft };
}

async function draftSpec(workflow_id: string) {
  const [row] = await ctx.testDb.db
    .select({ spec: workflowVersions.spec })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.draft_version_id))
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflow_id)));
  return (row?.spec ?? null) as WorkflowSpec | null;
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("authoring_spec_reopen");
  await setConfigKey(["llm", "critic", "enabled"], true);
  await setConfigKey(["llm", "critic", "min_steps"], 3);
});

afterAll(async () => {
  await setConfigKey(["llm", "critic", "enabled"], false);
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

describe("a reopened draft is authored against its saved spec", () => {
  test("open, patch and preview run the critic and the judge against the spec goal", async () => {
    const saved = await saveWorkflowDraft(
      {
        tenant_id: ctx.tenant_id,
        def: threeSteps("spec-reopen-visits"),
        spec: spec("Report the weekly visits as one line"),
        actor_id: ctx.user_id,
        request_source: "api",
      },
      ctx.testDb.db,
    );
    if (!saved.draft) throw new Error(saved.errors.join("; "));

    const criticPrompts: string[] = [];
    const judgePrompts: string[] = [];
    getMockProvider().generateOverrides.critic_authoring = (last) => {
      criticPrompts.push(last);
      return { passed: true, repairs: [], rationale: "matches the goal" };
    };
    getMockProvider().generateOverrides.judge = (last) => {
      judgePrompts.push(last);
      return { reason: "the summary line is present", missing: [], verdict: "passes" };
    };

    const { toolCtx, draft } = await openConversation();
    const opened = await openWorkflowDraftTool.execute(toolCtx, {
      workflow: "spec-reopen-visits",
    });
    expect(opened.ok).toBe(true);
    expect(draft().workflow?.spec?.goal).toBe("Report the weekly visits as one line");
    expect((opened.data as { requires_user_input?: boolean }).requires_user_input).toBeUndefined();

    const patched = await editWorkflowPatchTool.execute(toolCtx, {
      workflow: "spec-reopen-visits",
      step_patches: [
        { step_id: "load", op: "replace", path: "/expression", value: "return { visits: 4 };" },
      ],
    });
    expect(patched.ok).toBe(true);
    expect(
      (patched.data as { critic: { result: string; has_spec: boolean } }).critic,
    ).toMatchObject({ result: "pass", has_spec: true });
    expect(criticPrompts[0]).toContain("Report the weekly visits as one line");
    expect(criticPrompts[0]).toContain("Expected outputs:");

    const preview = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    const judge = (preview.data as { judge?: { verdict: string; reason: string } }).judge;
    expect(judge?.verdict).toBe("passes");
    expect(judgePrompts[0]).toContain("Report the weekly visits as one line");
    expect(judgePrompts[0]).toContain("output `summary`");
  });

  test("an unconfirmed spec goal reports judge gaps as a hint instead of blocking", async () => {
    const saved = await saveWorkflowDraft(
      {
        tenant_id: ctx.tenant_id,
        def: threeSteps("spec-reopen-advisory"),
        spec: spec("Report the weekly visits per country"),
        actor_id: ctx.user_id,
        request_source: "api",
      },
      ctx.testDb.db,
    );
    if (!saved.draft) throw new Error(saved.errors.join("; "));
    getMockProvider().generateOverrides.judge = () => ({
      reason: "no per-country breakdown",
      missing: ["visits per country"],
      verdict: "partial",
    });
    const { toolCtx } = await openConversation();
    await openWorkflowDraftTool.execute(toolCtx, { workflow: "spec-reopen-advisory" });
    const preview = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    const data = preview.data as {
      judge?: { verdict: string };
      requires_repair?: boolean;
      judge_hint?: string;
    };
    expect(data.judge?.verdict).toBe("partial");
    expect(data.requires_repair).toBeUndefined();
    expect(data.judge_hint).toContain("visits per country");
  });

  test("a workflow without a spec asks for its goal and saves the answer as a chat spec", async () => {
    const saved = await saveWorkflowDraft(
      {
        tenant_id: ctx.tenant_id,
        def: threeSteps("spec-reopen-missing"),
        actor_id: ctx.user_id,
        request_source: "api",
      },
      ctx.testDb.db,
    );
    if (!saved.draft) throw new Error(saved.errors.join("; "));
    const { toolCtx, draft } = await openConversation();
    const opened = await openWorkflowDraftTool.execute(toolCtx, {
      workflow: "spec-reopen-missing",
    });
    const openedData = opened.data as {
      requires_user_input?: boolean;
      spec_questions?: string[];
      user_prompt?: { tool: string };
    };
    expect(openedData.requires_user_input).toBe(true);
    expect(openedData.spec_questions).toEqual(["What should this workflow achieve?"]);
    expect(openedData.user_prompt?.tool).toBe("ask_user_form");

    const recorded = await editWorkflowPatchTool.execute(toolCtx, {
      workflow: "spec-reopen-missing",
      patches: [{ op: "add", path: "/goal", value: "Count the weekly visits" }],
    });
    expect(recorded.ok).toBe(true);
    expect(draft().workflow?.spec).toMatchObject({
      goal: "Count the weekly visits",
      origin: "chat",
    });

    const result = await persistAuthoringWorkflowDraft({
      ctx: toolCtx,
      fullDraft: draft(),
      def: workflowDefFromDraft(draft().workflow),
    });
    expect(result.ok).toBe(true);
    expect(await draftSpec(saved.draft.workflow_id)).toMatchObject({
      goal: "Count the weekly visits",
      origin: "chat",
    });
  });
});

describe("author_workflow fills the spec", () => {
  test("the authored draft carries a chat spec with the goal and the declared outputs", async () => {
    getMockProvider().generateOverrides.generate = () => ({
      name: "spec-authored",
      slug: "spec-authored",
      output_schema: { type: "object", properties: { summary: { type: "string" } } },
      steps: [transform("report", "return { summary: 'ok' };")],
    });
    const { toolCtx, draft } = await openConversation();
    const result = await authorWorkflowTool.execute(toolCtx, {
      goal: "Summarise the day in one line",
      input_example: { day: "2026-01-01" },
    });
    expect(result.ok).toBe(true);
    expect(draft().workflow?.spec).toEqual({
      goal: "Summarise the day in one line",
      inputs: [{ name: "day" }],
      outputs: [{ name: "summary" }],
      delivery: null,
      conventions_applied: [],
      evidence: [],
      open_questions: [],
      origin: "chat",
    });
  });
});
