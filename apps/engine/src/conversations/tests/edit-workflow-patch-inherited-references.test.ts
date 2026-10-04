import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversations, tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { editWorkflowPatchTool } from "../tools/edit-workflow-patch.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x1a4e_417ed);
const PLAN =
  "const current = input.scope.rollup_window\n  ? input.scope.rollup_window.data\n  : input.scope.window.data;\nreturn current;";
const CLEAN = "return input.scope.rollup_window.data;";

let ctx: ConversationTestCtx;
let sequence = 0;
beforeAll(async () => {
  ctx = await createConversationTestCtx("patch-inherited-refs");
});
afterAll(async () => {
  await ctx.cleanup();
});

const steps = (plan: string) => [
  {
    id: "rollup_window",
    kind: "transform",
    language: "javascript",
    expression: "return { a: 1 };",
  },
  { id: "comparison_plan", kind: "transform", language: "javascript", expression: plan },
];

async function seed(opts: { active: string; tenant_id?: string; savedDraft?: string }) {
  const slug = `rollup-${++sequence}`;
  const tenant_id = opts.tenant_id ?? ctx.tenant_id;
  const db = ctx.testDb.db;
  const [wf] = await db
    .insert(workflows)
    .values({ tenant_id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  const version = async (n: number, plan: string) => {
    const [row] = await db
      .insert(workflowVersions)
      .values({
        tenant_id,
        workflow_id: wf.id,
        version: n,
        dag: { name: slug, slug, steps: steps(plan) },
      })
      .returning();
    if (!row) throw new Error("version insert failed");
    return row.id;
  };
  const active = await version(1, opts.active);
  const draft = opts.savedDraft ? await version(2, opts.savedDraft) : null;
  await db
    .update(workflows)
    .set({ current_version_id: active, ...(draft ? { draft_version_id: draft } : {}) })
    .where(eq(workflows.id, wf.id));
  const [conv] = await db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active", target_workflow_id: wf.id })
    .returning();
  if (!conv) throw new Error("conversation insert failed");
  return { slug, conversation_id: conv.id };
}

function draftOf(slug: string, plan: string): DraftDocument {
  return {
    workflow: { name: slug, slug, steps: steps(plan) },
    latest_preview: {
      ok: true,
      summary: "preview seeded for test fixture",
      step_traces: ["rollup_window", "comparison_plan"].map((step_id) => ({
        step_id,
        kind: "transform",
        status: "succeeded",
        output_preview: { a: 1 },
      })),
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

async function patch(conversation_id: string, draft: DraftDocument, patches: unknown[]) {
  const ref = { current: draft };
  const toolCtx: ToolContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => ref.current,
    setDraft: async (next) => {
      ref.current = next;
    },
  };
  const result = await editWorkflowPatchTool.execute(toolCtx, { patches });
  return { result, data: result.data as Record<string, unknown>, draft: ref.current };
}
const BUDGET = [{ op: "add", path: "/max_llm_tokens_per_run", value: 70_000 }];

test("a field-only patch passes, leaves the transform byte-identical, and reports without advising", async () => {
  const bound = await seed({ active: PLAN });
  const { result, data, draft } = await patch(
    bound.conversation_id,
    draftOf(bound.slug, PLAN),
    BUDGET,
  );
  expect(result.ok).toBe(true);
  expect(draft.workflow?.steps?.[1]).toMatchObject({ expression: PLAN });
  const notice = data.inherited_step_references as { code: string; references: unknown[] };
  expect(notice.code).toBe("inherited_step_reference");
  expect(notice.references).toEqual([
    { step_id: "comparison_plan", field: "expression", absent_step: "window" },
  ]);
  expect(JSON.stringify(notice)).not.toMatch(/did_you_mean|did you mean|unresolved|fix/i);
});

test("a conversation bound to nothing inherits nothing", async () => {
  const { data } = await patch(uuid(), draftOf("unbound", PLAN), BUDGET);
  expect(data.error_code).toBe("workflow_unresolved_step_reference");
});

test("a reference the patch introduces still blocks, and only it is listed", async () => {
  const bound = await seed({ active: PLAN });
  const { data, draft } = await patch(bound.conversation_id, draftOf(bound.slug, PLAN), [
    { op: "replace", path: "/steps/0/expression", value: "return input.scope.rolup_window;" },
  ]);
  expect(data.error_code).toBe("workflow_unresolved_step_reference");
  const listed = data.unresolved_references as Array<{ bad_reference: string }>;
  expect(listed.map((e) => e.bad_reference)).toEqual(["rolup_window"]);
  expect(data.inherited_step_references).toBeDefined();
  expect(draft.workflow?.steps?.[0]).toMatchObject({ expression: "return { a: 1 };" });
});

test("removing a step an UNGUARDED reader still names blocks", async () => {
  const bound = await seed({ active: CLEAN });
  const { data } = await patch(bound.conversation_id, draftOf(bound.slug, CLEAN), [
    { op: "remove", path: "/steps/0" },
  ]);
  expect(data.error_code).toBe("workflow_unresolved_step_reference");
  const listed = data.unresolved_references as Array<{ bad_reference: string }>;
  expect(listed.map((e) => e.bad_reference)).toContain("rollup_window");
});

test("removing a step only a GUARDED reader names does not block on that read", async () => {
  const bound = await seed({ active: PLAN });
  const { data } = await patch(bound.conversation_id, draftOf(bound.slug, PLAN), [
    { op: "remove", path: "/steps/0" },
  ]);
  expect(data.error_code).toBeUndefined();
  expect(data.inherited_step_references).toBeDefined();
});

test("a target owned by another tenant vouches for nothing", async () => {
  const [other] = await ctx.testDb.db
    .insert(tenants)
    .values({ slug: "t-other-inherited", display_name: "Other" })
    .returning();
  if (!other) throw new Error("tenant insert failed");
  const foreign = await seed({ active: PLAN, tenant_id: other.id });
  const { data } = await patch(foreign.conversation_id, draftOf(foreign.slug, PLAN), BUDGET);
  expect(data.error_code).toBe("workflow_unresolved_step_reference");
});

test("a dangling SAVED DRAFT vouches for nothing when the active version is clean", async () => {
  const bound = await seed({ active: CLEAN, savedDraft: PLAN });
  const { data } = await patch(bound.conversation_id, draftOf(bound.slug, PLAN), BUDGET);
  expect(data.error_code).toBe("workflow_unresolved_step_reference");
});

test("a draft of a different workflow than the conversation's target inherits nothing", async () => {
  const bound = await seed({ active: PLAN });
  const { data } = await patch(bound.conversation_id, draftOf("some-other-workflow", PLAN), BUDGET);
  expect(data.error_code).toBe("workflow_unresolved_step_reference");
});
