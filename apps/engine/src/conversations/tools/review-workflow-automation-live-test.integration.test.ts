import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  conversations,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { createEmptyDraftDocument, refreshDraftSummary } from "../authoring-state.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { DraftDocument } from "../types.ts";
import { reviewWorkflowAutomationTool } from "./review-workflow-automation.ts";

let ctx: ConversationTestCtx;
let sequence = 0;

beforeAll(async () => {
  ctx = await createConversationTestCtx("review_workflow_live_test");
});

afterAll(async () => {
  await ctx.cleanup();
});

function principal(): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  };
}

function preparedDraft(params: {
  workflow_id: string;
  workflow_version_id: string;
  input: unknown;
  preview_mutation_seq?: number;
}): DraftDocument {
  const base = createEmptyDraftDocument("workflow_authoring");
  const mutation_seq = 2;
  return refreshDraftSummary({
    ...base,
    workflow: { name: "Prepared test", steps: [] },
    latest_preview: { ok: true, summary: "Prepared", input: params.input },
    state: {
      ...base.state!,
      mode: "workflow",
      workflow_mutation_seq: mutation_seq,
      checkpoints: {
        workflow_persisted: {
          key: "workflow_persisted",
          verified_at: "2026-01-01T00:00:00.000Z",
          verified_by_tool: "save_workflow_draft",
          mutation_seq,
          ok: true,
          summary: "Saved",
          resource_ref: {
            kind: "workflow",
            id: params.workflow_id,
            version_id: params.workflow_version_id,
          },
        },
        workflow_previewed: {
          key: "workflow_previewed",
          verified_at: "2026-01-01T00:00:00.000Z",
          verified_by_tool: "dry_run_workflow",
          mutation_seq: params.preview_mutation_seq ?? mutation_seq,
          ok: true,
          summary: "Prepared",
          resource_ref: {
            kind: "workflow",
            id: params.workflow_id,
            version_id: params.workflow_version_id,
          },
        },
      },
      persisted_resources: [
        {
          kind: "workflow",
          id: params.workflow_id,
          slug: "prepared-test",
          name: "Prepared test",
          version_id: params.workflow_version_id,
          version: 2,
          environment: "dev",
          saved_at: "2026-01-01T00:00:00.000Z",
          draft_version_id: params.workflow_version_id,
          persistence_kind: "draft",
        },
      ],
    },
  });
}

async function fixture(options: { prod?: boolean; preview_mutation_seq?: number } = {}) {
  const slug = `review-live-test-${++sequence}`;
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenant_id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("workflow");
  const [active] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        steps: [{ id: "first", kind: "transform", expression: "return {};" }],
      },
    })
    .returning();
  const [draftVersion] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 2,
      dag: {
        name: slug,
        slug,
        steps: [{ id: "prepared", kind: "transform", expression: "return {};" }],
      },
    })
    .returning();
  if (!active || !draftVersion) throw new Error("versions");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: active.id, draft_version_id: draftVersion.id })
    .where(eq(workflows.id, workflow.id));
  if (options.prod) {
    await ctx.testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      cron: "0 9 * * *",
      execution_mode: "prod",
    });
  }
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenant_id,
      owner_id: ctx.user_id,
      target_workflow_id: workflow.id,
      status: "active",
      draft: { workflow: { name: slug, steps: [] } },
    })
    .returning();
  if (!conversation) throw new Error("conversation");
  let draft = preparedDraft({
    workflow_id: workflow.id,
    workflow_version_id: draftVersion.id,
    input: { recipient: "one@example.test" },
    ...(options.preview_mutation_seq !== undefined
      ? { preview_mutation_seq: options.preview_mutation_seq }
      : {}),
  });
  return {
    workflow,
    draftVersion,
    conversation,
    draft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  };
}

async function review(prepared: Awaited<ReturnType<typeof fixture>>) {
  return reviewWorkflowAutomationTool.execute(
    {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      conversation_id: prepared.conversation.id,
      connector_id: null,
      workflow_id: prepared.workflow.id,
      principal: principal(),
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        actor_type: "user",
        db: ctx.testDb.db,
      }),
      getDraft: prepared.draft,
      setDraft: prepared.setDraft,
    },
    { workflow_id: prepared.workflow.id },
  );
}

test("seeds one DEV test intent for the fresh saved version and preview input", async () => {
  const f = await fixture();
  expect(await review(f)).toMatchObject({ ok: true });
  const liveTest = f.draft().session?.live_test;
  expect(liveTest).toMatchObject({
    workflow_id: f.workflow.id,
    workflow_version_id: f.draftVersion.id,
    environment: "dev",
    input: { recipient: "one@example.test" },
    input_digest: workflowJsonDigest({ recipient: "one@example.test" }),
    state: "pending",
  });
  expect(liveTest?.idempotency_key).toBe(
    `conversation-live-test:${f.conversation.id}:${f.draftVersion.id}:${workflowJsonDigest({ recipient: "one@example.test" })}`,
  );
});

test("does not seed an intent from a stale preview or a PROD saved change", async () => {
  const stale = await fixture({ preview_mutation_seq: 1 });
  expect(await review(stale)).toMatchObject({ ok: true });
  expect(stale.draft().session?.live_test).toBeUndefined();
  const prod = await fixture({ prod: true });
  expect(await review(prod)).toMatchObject({ ok: true });
  expect(prod.draft().session?.live_test).toBeUndefined();
});

test("binds a renewed DEV test intent to the changed preview input", async () => {
  const f = await fixture();
  await review(f);
  const first = f.draft().session?.live_test;
  const changed = preparedDraft({
    workflow_id: f.workflow.id,
    workflow_version_id: f.draftVersion.id,
    input: { recipient: "two@example.test" },
  });
  await f.setDraft(changed);
  await review(f);
  const second = f.draft().session?.live_test;
  expect(first?.idempotency_key).not.toBe(second?.idempotency_key);
  expect(second).toMatchObject({
    input: { recipient: "two@example.test" },
    input_digest: workflowJsonDigest({ recipient: "two@example.test" }),
  });
});
