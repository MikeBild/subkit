import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations, workflows } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import {
  createEmptyDraftDocument,
  withWorkflowDraft,
  withWorkflowPersisted,
} from "../authoring-state/index.ts";
import { hydrateBoundWorkflow } from "../draft.ts";
import { workflowDefFromDraft } from "../persistence/commit-workflow.ts";
import { persistAuthoringWorkflowDraft } from "../persistence/persist-authoring-workflow-draft.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("activated_draft_binding");
});
afterAll(async () => {
  await ctx?.cleanup();
});

async function activatedDraft(slug: string) {
  const def = {
    name: "Resource report",
    slug,
    steps: [
      { id: "resources", kind: "transform", language: "javascript", expression: "return [];" },
    ],
  };
  const result = await saveWorkflowDraft(
    { tenant_id: ctx.tenant_id, def, actor_id: null, request_source: "api" },
    ctx.testDb.db,
  );
  if (!result.draft) throw new Error(result.errors.join("; "));
  const saved = result.draft;
  const bound = withWorkflowPersisted(
    withWorkflowDraft(createEmptyDraftDocument("workflow_authoring"), def),
    {
      kind: "workflow",
      id: saved.workflow_id,
      name: def.name,
      slug,
      version_id: saved.version_id,
      version: saved.version,
      draft_version_id: saved.version_id,
      current_version_id: null,
      persistence_kind: "draft",
      environment: null,
      saved_at: "2026-01-01T00:00:00Z",
    },
  );
  const edited = withWorkflowDraft(bound, {
    ...def,
    steps: [
      ...def.steps,
      {
        id: "volumes",
        kind: "transform",
        language: "javascript",
        expression: "return { volumes: [] };",
      },
    ],
  });
  await ctx.testDb.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: saved.version_id, draft_version_id: null })
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, saved.workflow_id)));
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenant_id,
      status: "active",
      target_workflow_id: saved.workflow_id,
      draft: edited,
    })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  return { saved, edited, conversation };
}

test("saving after activation retains local extensions and observes the promoted draft", async () => {
  const { saved, edited } = await activatedDraft("activated-report");
  const hydrated = await hydrateBoundWorkflow(
    ctx.tenant_id,
    saved.workflow_id,
    edited,
    ctx.testDb.db,
  );
  const ref = hydrated.state?.persisted_resources.find((item) => item.id === saved.workflow_id);
  expect(ref).toMatchObject({
    draft_version_id: null,
    current_version_id: saved.version_id,
    persistence_kind: "active",
  });
  expect(hydrated.workflow.steps).toEqual(edited.workflow.steps);
  expect(hydrated.state?.workflow_mutation_seq).toBe(edited.state?.workflow_mutation_seq);
  const next = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: saved.workflow_id,
      expected_draft_version_id: ref?.draft_version_id ?? null,
      def: workflowDefFromDraft(hydrated.workflow),
      actor_id: null,
      request_source: "tool-chain",
    },
    ctx.testDb.db,
  );
  expect(next.draft).toBeDefined();
  expect(next.draft?.version_id).not.toBe(saved.version_id);
  expect(next.draft?.current_version_id).toBe(saved.version_id);
  expect(next.draft?.definition.steps).toHaveLength(2);
});

test("a newer draft is not adopted over local changes", async () => {
  const { saved, edited } = await activatedDraft("concurrent-report");
  const competing = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: saved.workflow_id,
      expected_draft_version_id: null,
      def: { ...workflowDefFromDraft(edited.workflow), name: "Other writer" },
      actor_id: null,
      request_source: "api",
    },
    ctx.testDb.db,
  );
  expect(competing.draft).toBeDefined();
  const hydrated = await hydrateBoundWorkflow(
    ctx.tenant_id,
    saved.workflow_id,
    edited,
    ctx.testDb.db,
  );
  const ref = hydrated.state?.persisted_resources.find((item) => item.id === saved.workflow_id);
  expect(ref?.draft_version_id).toBe(saved.version_id);
  expect(hydrated.workflow).toEqual(edited.workflow);
  const next = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: saved.workflow_id,
      expected_draft_version_id: ref?.draft_version_id ?? null,
      def: workflowDefFromDraft(hydrated.workflow),
      actor_id: null,
      request_source: "tool-chain",
    },
    ctx.testDb.db,
  );
  expect(next.code).toBe("draft_conflict");
});

test("a draft created after reconciliation still conflicts at save time", async () => {
  const { saved, edited } = await activatedDraft("racing-report");
  const hydrated = await hydrateBoundWorkflow(
    ctx.tenant_id,
    saved.workflow_id,
    edited,
    ctx.testDb.db,
  );
  const ref = hydrated.state?.persisted_resources.find((item) => item.id === saved.workflow_id);
  expect(ref?.draft_version_id).toBeNull();
  await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: saved.workflow_id,
      expected_draft_version_id: null,
      def: { ...workflowDefFromDraft(edited.workflow), name: "Racing writer" },
      actor_id: null,
      request_source: "api",
    },
    ctx.testDb.db,
  );
  const next = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: saved.workflow_id,
      expected_draft_version_id: ref?.draft_version_id ?? null,
      def: workflowDefFromDraft(hydrated.workflow),
      actor_id: null,
      request_source: "tool-chain",
    },
    ctx.testDb.db,
  );
  expect(next.code).toBe("draft_conflict");
});

test("another activated version does not replace the observed base", async () => {
  const { saved, edited } = await activatedDraft("replaced-active-report");
  const other = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: saved.workflow_id,
      expected_draft_version_id: null,
      def: { ...workflowDefFromDraft(edited.workflow), name: "Other active definition" },
      actor_id: null,
      request_source: "api",
    },
    ctx.testDb.db,
  );
  if (!other.draft) throw new Error(other.errors.join("; "));
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: other.draft.version_id, draft_version_id: null })
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, saved.workflow_id)));
  const hydrated = await hydrateBoundWorkflow(
    ctx.tenant_id,
    saved.workflow_id,
    edited,
    ctx.testDb.db,
  );
  const ref = hydrated.state?.persisted_resources.find((item) => item.id === saved.workflow_id);
  expect(ref?.draft_version_id).toBe(saved.version_id);
  expect(hydrated.workflow.steps).toEqual(edited.workflow.steps);
});

test("the authoring save updates its binding after promotion and reports a later conflict", async () => {
  const { saved, edited, conversation } = await activatedDraft("authoring-report");
  let local: DraftDocument = await hydrateBoundWorkflow(
    ctx.tenant_id,
    saved.workflow_id,
    edited,
    ctx.testDb.db,
  );
  const toolContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversation.id,
    actor_id: null,
    workflow_id: saved.workflow_id,
    connector_id: null,
    engineClient: new EngineClient({ db: ctx.testDb.db, tenant_id: ctx.tenant_id, actor_id: null }),
    getDraft: () => local,
    setDraft: async (next: DraftDocument) => {
      local = next;
    },
  };
  const persisted = await persistAuthoringWorkflowDraft({
    ctx: toolContext,
    fullDraft: local,
    def: workflowDefFromDraft(local.workflow),
  });
  expect(persisted.ok).toBe(true);
  const ref = local.state?.persisted_resources.find((item) => item.id === saved.workflow_id);
  expect(ref?.draft_version_id).not.toBe(saved.version_id);
  expect(ref?.current_version_id).toBe(saved.version_id);
  const competing = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: saved.workflow_id,
      expected_draft_version_id: ref?.draft_version_id ?? null,
      def: { ...workflowDefFromDraft(local.workflow), name: "Concurrent change" },
      actor_id: null,
      request_source: "api",
    },
    ctx.testDb.db,
  );
  if (!competing.draft) throw new Error(competing.errors.join("; "));
  const conflict = await persistAuthoringWorkflowDraft({
    ctx: toolContext,
    fullDraft: local,
    def: workflowDefFromDraft(local.workflow),
  });
  expect(conflict.ok).toBe(false);
  expect(JSON.stringify(conflict.data)).toContain(competing.draft.version_id);
  expect(local.workflow.steps).toEqual(edited.workflow.steps);
});
