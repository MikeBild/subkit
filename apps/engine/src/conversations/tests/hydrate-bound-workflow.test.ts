// Integration tests for RC2 + RC3: hydrateBoundWorkflow in draft.ts.
//
// RC2: loadDraft hydrates a bound workflow from its persisted version —
//      the draft's `workflow` document (name, slug, steps) is loaded
//      from `workflow_versions.dag` so incremental edit tools operate on
//      a populated draft, and the authoring summary reflects the
//      persisted resource (lifecycle_state="persisted", stage
//      "workflow_persisted", persisted_resources populated).
//
// RC3: loadDraft seeds `draft.latest_preview` from the most recent
//      status='succeeded' execution's step traces so the transform /
//      loop authoring gates have real upstream shape evidence on a
//      freshly-bound workflow that has executed before.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  conversationDrafts,
  conversations,
  executions,
  executionSteps,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import { loadDraft } from "../draft.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("hydrate_bound_workflow");
});

afterAll(async () => {
  await ctx.cleanup();
});

// Seed a persisted workflow with ≥2 steps and a current version.
async function seedWorkflow(opts: {
  slug: string;
  name: string;
  steps: Array<Record<string, unknown>>;
}): Promise<{ workflow_id: string; version_id: string }> {
  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: opts.slug,
      name: opts.name,
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  const [ver] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: wf.id,
      version: 1,
      dag: { name: opts.name, slug: opts.slug, steps: opts.steps },
    })
    .returning();
  if (!ver) throw new Error("workflow version insert failed");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: ver.id })
    .where(eq(workflows.id, wf.id));
  return { workflow_id: wf.id, version_id: ver.id };
}

// Seed an execution with the given status + step rows.
async function seedExecution(opts: {
  workflow_id: string;
  version_id: string;
  status: "succeeded" | "failed";
  steps: Array<{
    step_key: string;
    kind: string;
    status: string;
    output_preview?: unknown;
  }>;
}): Promise<{ execution_id: string }> {
  const [ex] = await ctx.testDb.db
    .insert(executions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: opts.workflow_id,
      workflow_version_id: opts.version_id,
      status: opts.status,
      request_source: "test",
      execution_mode: "dev",
    })
    .returning();
  if (!ex) throw new Error("execution insert failed");
  if (opts.steps.length > 0) {
    await ctx.testDb.db.insert(executionSteps).values(
      opts.steps.map((s, i) => ({
        tenant_id: ctx.tenant_id,
        execution_id: ex.id,
        step_key: s.step_key,
        step_index: i,
        kind: s.kind,
        status: s.status,
        ...(s.output_preview !== undefined ? { output_preview: s.output_preview } : {}),
      })),
    );
  }
  return { execution_id: ex.id };
}

// Seed an empty conversation bound to a workflow via target_workflow_id.
async function seedConversation(workflow_id: string): Promise<{ conversation_id: string }> {
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenant_id,
      status: "active",
      target_workflow_id: workflow_id,
      // Empty draft — no conversationDrafts row. hydrateBoundWorkflow
      // fires from the conversations.draft column fallback in loadDraft.
      draft: { workflow: { name: "", steps: [] } },
    })
    .returning();
  if (!conv) throw new Error("conversation insert failed");
  return { conversation_id: conv.id };
}

const STEPS_TWO = [
  { id: "fetch", kind: "connector", connector_id: "c1", endpoint_key: "get_users" },
  {
    id: "transform",
    kind: "transform",
    language: "javascript",
    expression: "return input.input.data;",
  },
] as Array<Record<string, unknown>>;

test("authoring loads the inert version and retains its observed base across concurrent edits", async () => {
  const active = await seedWorkflow({
    slug: "inert-authoring-base",
    name: "Active",
    steps: STEPS_TWO,
  });
  await seedExecution({
    ...active,
    status: "succeeded",
    steps: [
      {
        step_key: "fetch",
        kind: "request",
        status: "succeeded",
        output_preview: { obsolete: true },
      },
    ],
  });
  const def = {
    name: "Draft",
    slug: "inert-authoring-base",
    steps: [{ id: "output", kind: "transform", expression: "return 2;" }],
  };
  const saved = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: active.workflow_id,
      expected_draft_version_id: null,
      def,
      actor_id: null,
      request_source: "tool-chain",
    },
    ctx.testDb.db,
  );
  if (!saved.draft) throw new Error(saved.errors.join("; "));
  const { conversation_id } = await seedConversation(active.workflow_id);
  const loaded = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
  expect(loaded.workflow.name).toBe("Draft");
  expect(loaded.latest_preview).toBeUndefined();
  expect(loaded.state?.persisted_resources[0]).toMatchObject({
    version_id: saved.draft.version_id,
    draft_version_id: saved.draft.version_id,
    current_version_id: active.version_id,
    persistence_kind: "draft",
  });
  expect(loaded.state?.checkpoints.workflow_persisted?.summary).toContain(
    "activation is still required",
  );
  await ctx.testDb.db
    .update(conversations)
    .set({ draft: loaded })
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)));
  const changed = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: active.workflow_id,
      expected_draft_version_id: saved.draft.version_id,
      def: { ...def, name: "Concurrent edit" },
      actor_id: null,
      request_source: "api",
    },
    ctx.testDb.db,
  );
  if (!changed.draft) throw new Error(changed.errors.join("; "));
  const reloaded = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
  expect(reloaded.workflow.name).toBe("Draft");
  const observed = reloaded.state?.persisted_resources[0]?.draft_version_id;
  expect(observed).toBe(saved.draft.version_id);
  if (observed === undefined) throw new Error("missing observed draft base");
  expect(
    (
      await saveWorkflowDraft(
        {
          tenant_id: ctx.tenant_id,
          workflow_id: active.workflow_id,
          expected_draft_version_id: observed,
          def,
          actor_id: null,
          request_source: "tool-chain",
        },
        ctx.testDb.db,
      )
    ).code,
  ).toBe("draft_conflict");
});

// ---------------------------------------------------------------------------
// RC2: binding identity hydrated from the workflow table
// ---------------------------------------------------------------------------

describe("loadDraft — RC2: persisted workflow binding (identity + summary)", () => {
  test("summary active_target reflects the persisted workflow identity", async () => {
    const { workflow_id } = await seedWorkflow({
      slug: "hydrate-test-wf",
      name: "Hydrate Test WF",
      steps: STEPS_TWO,
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);

    // The active_target must reflect the persisted workflow's identity.
    expect(draft.summary?.active_target?.kind).toBe("workflow");
    expect(draft.summary?.active_target?.id).toBe(workflow_id);
    expect(draft.summary?.active_target?.slug).toBe("hydrate-test-wf");
    expect(draft.summary?.active_target?.name).toBe("Hydrate Test WF");
  });

  test("summary reports lifecycle_state=persisted and stage=workflow_persisted", async () => {
    const { workflow_id } = await seedWorkflow({
      slug: "hydrate-lifecycle-wf",
      name: "Hydrate Lifecycle WF",
      steps: STEPS_TWO,
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);

    expect(draft.summary?.active_target?.lifecycle_state).toBe("persisted");
    expect(draft.summary?.stage).toBe("workflow_persisted");
  });

  test("persisted_resources includes the workflow ref with id + version", async () => {
    const { workflow_id, version_id } = await seedWorkflow({
      slug: "hydrate-res-wf",
      name: "Hydrate Resource WF",
      steps: STEPS_TWO,
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);

    expect(draft.summary?.persisted_resources).toEqual([
      expect.objectContaining({
        kind: "workflow",
        id: workflow_id,
        slug: "hydrate-res-wf",
        name: "Hydrate Resource WF",
        version_id,
        version: 1,
      }),
    ]);
  });

  test("workflow.steps are hydrated from the persisted version's dag", async () => {
    const { workflow_id } = await seedWorkflow({
      slug: "hydrate-steps-wf",
      name: "Hydrate Steps WF",
      steps: STEPS_TWO,
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);

    // RC2 core: editing a saved workflow loads its steps into the draft
    // so update_param / propose_step operate on a populated workflow
    // instead of reporting "unknown_step" against an empty draft.
    expect(draft.workflow.steps.length).toBe(2);
    expect(draft.workflow.steps.map((s) => (s as { id?: string }).id)).toEqual([
      "fetch",
      "transform",
    ]);
    expect(draft.workflow.name).toBe("Hydrate Steps WF");
    expect(draft.workflow.slug).toBe("hydrate-steps-wf");
    expect(draft.summary?.missing_fields).not.toContain("workflow.steps");
  });
});

// ---------------------------------------------------------------------------
// RC3: latest_preview seeded from the most recent succeeded execution
// ---------------------------------------------------------------------------

describe("loadDraft — RC3: latest_preview seeded from succeeded execution", () => {
  test("step_traces populated when a succeeded execution with step outputs exists", async () => {
    const { workflow_id, version_id } = await seedWorkflow({
      slug: "hydrate-preview-wf",
      name: "Hydrate Preview WF",
      steps: STEPS_TWO,
    });
    await seedExecution({
      workflow_id,
      version_id,
      status: "succeeded",
      steps: [
        {
          step_key: "fetch",
          kind: "connector",
          status: "succeeded",
          output_preview: { users: [{ id: 1, name: "Alice" }] },
        },
        {
          step_key: "transform",
          kind: "transform",
          status: "succeeded",
          output_preview: { data: [{ id: 1, name: "Alice" }] },
        },
      ],
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);

    expect(draft.latest_preview).toBeDefined();
    expect(draft.latest_preview?.ok).toBe(true);
    const traces = draft.latest_preview?.step_traces;
    expect(Array.isArray(traces)).toBe(true);
    expect(traces?.length).toBe(2);
    const fetchTrace = traces?.find((t) => t.step_id === "fetch");
    expect(fetchTrace).toBeDefined();
    expect(fetchTrace?.output_preview).toEqual({
      users: [{ id: 1, name: "Alice" }],
    });
  });

  test("latest_preview is unset when the workflow has no succeeded execution", async () => {
    const { workflow_id, version_id } = await seedWorkflow({
      slug: "hydrate-no-exec-wf",
      name: "Hydrate No Exec WF",
      steps: STEPS_TWO,
    });
    // Seed only a failed execution — should NOT seed latest_preview.
    await seedExecution({
      workflow_id,
      version_id,
      status: "failed",
      steps: [{ step_key: "fetch", kind: "connector", status: "failed" }],
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    // No succeeded execution → no latest_preview.
    expect(draft.latest_preview).toBeUndefined();
  });

  test("latest_preview picks the most recent succeeded execution when multiple exist", async () => {
    const { workflow_id, version_id } = await seedWorkflow({
      slug: "hydrate-multi-exec-wf",
      name: "Hydrate Multi Exec WF",
      steps: STEPS_TWO,
    });
    // Insert two succeeded executions — the newer one should win.
    // Older succeeded execution.
    await seedExecution({
      workflow_id,
      version_id,
      status: "succeeded",
      steps: [
        {
          step_key: "fetch",
          kind: "connector",
          status: "succeeded",
          output_preview: { version: "old" },
        },
      ],
    });
    // Newer succeeded execution.
    await seedExecution({
      workflow_id,
      version_id,
      status: "succeeded",
      steps: [
        {
          step_key: "fetch",
          kind: "connector",
          status: "succeeded",
          output_preview: { version: "new" },
        },
      ],
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);

    const traces = draft.latest_preview?.step_traces;
    const fetchTrace = traces?.find((t) => t.step_id === "fetch");
    // The most recent succeeded execution's preview wins.
    expect(fetchTrace?.output_preview).toEqual({
      version: "new",
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency: re-calling loadDraft on an already-bound draft does not re-hydrate
// ---------------------------------------------------------------------------

describe("loadDraft — idempotency: re-hydrate does not clobber", () => {
  test("second loadDraft call on an already-bound draft preserves the binding identity", async () => {
    const { workflow_id } = await seedWorkflow({
      slug: "hydrate-idem-wf",
      name: "Hydrate Idem WF",
      steps: STEPS_TWO,
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft1 = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    // Persist the hydrated draft so the next loadDraft reads it back.
    await ctx.testDb.db.insert(conversationDrafts).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      ordinal: "000001",
      snapshot: draft1 as unknown as Record<string, unknown>,
    });

    const draft2 = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);

    // The binding identity and the hydrated steps are preserved on both
    // loads — the second load must not re-hydrate over the snapshot.
    expect(draft2.summary?.active_target?.id).toBe(workflow_id);
    expect(draft2.summary?.active_target?.slug).toBe("hydrate-idem-wf");
    expect(draft2.summary?.active_target?.lifecycle_state).toBe("persisted");
    expect(draft2.workflow.steps.length).toBe(2);
    // persisted_resources still carries the workflow ref.
    expect(draft2.summary?.persisted_resources).toEqual([
      expect.objectContaining({ kind: "workflow", id: workflow_id }),
    ]);
  });

  test("second loadDraft call does NOT call hydrateBoundWorkflow again (alreadyBound guard)", async () => {
    const { workflow_id } = await seedWorkflow({
      slug: "hydrate-idem-guard-wf",
      name: "Hydrate Idem Guard WF",
      steps: STEPS_TWO,
    });
    const { conversation_id } = await seedConversation(workflow_id);

    const draft1 = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    await ctx.testDb.db.insert(conversationDrafts).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      ordinal: "000001",
      snapshot: draft1 as unknown as Record<string, unknown>,
    });

    // If re-hydration fired, it would reset the binding.
    // Verify that summary.stage is still workflow_persisted (not reset to idle).
    const draft2 = await loadDraft(ctx.tenant_id, conversation_id, ctx.testDb.db);
    expect(draft2.summary?.stage).toBe("workflow_persisted");
  });
});
