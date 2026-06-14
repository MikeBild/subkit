import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { runWorkflowTool } from "../tools/generated/writes/run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("run_workflow_tool");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedWorkflow(): Promise<{
  workflow_id: string;
  version_id: string;
}> {
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "berlin-weather",
      name: "Berlin Weather",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: "Berlin Weather",
        slug: "berlin-weather",
        input_schema: {
          type: "object",
          required: ["date"],
          properties: {
            date: { type: "string" },
          },
        },
        steps: [
          {
            id: "shape",
            kind: "transform",
            expression: "return { date: input.input.date };",
            language: "javascript",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("workflow version insert failed");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return { workflow_id: workflow.id, version_id: version.id };
}

function buildToolCtx(params: {
  conversation_id: string;
  draft: DraftDocument;
  setDraft: (next: DraftDocument) => Promise<void>;
}): ToolContext {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching ToolContext
  const engineClientStub: any = {
    context: {
      actor_id: ctx.user_id,
      actor_type: "user",
    },
    workflows: {
      get: async (id: string) => {
        const { getWorkflow } = await import("../../workflows/service.ts");
        return getWorkflow(ctx.tenant_id, id, ctx.testDb.db);
      },
    },
    audit_write: async (entry: Record<string, unknown>) => {
      const { auditAwait } = await import("../../audit/audit.ts");
      const { AuditAction } = await import("../../audit/types.ts");
      return auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "user",
          actor_id: ctx.user_id,
          action: AuditAction.EXECUTION_STARTED,
          resource_type: String(entry.resource_type),
          resource_id: String(entry.resource_id),
          result: (entry.result as "success" | "error" | "denied") ?? "success",
          metadata: {
            via_action: String(entry.action),
            ...((entry.metadata as Record<string, unknown>) ?? {}),
          },
        },
        ctx.testDb.db,
      );
    },
  };
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: params.conversation_id,
    actor_id: ctx.user_id,
    // Seed a real principal so the now-mandatory RBAC gate inside
    // run_workflow proceeds (system-account principal sees all
    // permissions in the evaluator by default).
    principal: {
      provider: "test",
      kind: "user",
      id: ctx.user_id,
      tenant_id: ctx.tenant_id,
      roles: ["admin"],
    },
    connector_id: null,
    workflow_id: null,
    permission_mode: "auto",
    engineClient: engineClientStub,
    getDraft: () => params.draft,
    setDraft: params.setDraft,
  };
}

describe("run_workflow tool", () => {
  test("binds the saved workflow into the next draft and normalizes stringified input", async () => {
    const { workflow_id } = await seedWorkflow();
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: {
          workflow: { name: "new-workflow", steps: [] },
          state: {
            mode: "execution",
            stage: "workflow_executed",
            connector_mutation_seq: 0,
            workflow_mutation_seq: 0,
            checkpoints: {},
            persisted_resources: [],
            latest_execution: null,
            latest_diagnosis: null,
          },
        },
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    let nextDraft: unknown = null;
    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft: conversation.draft as DraftDocument,
        setDraft: async (draft) => {
          nextDraft = draft;
        },
      }),
      {
        workflow: workflow_id,
        environment: "dev",
        input: '{"date":"tomorrow +1"}',
      },
    );

    expect(result.ok).toBe(true);
    if (!nextDraft) throw new Error("next draft was not captured");
    const capturedDraft = nextDraft as DraftDocument;
    expect(capturedDraft.summary?.active_target).toEqual({
      kind: "workflow",
      id: workflow_id,
      slug: "berlin-weather",
      name: "Berlin Weather",
      environment: null,
      lifecycle_state: "persisted",
    });
    expect(capturedDraft.summary?.persisted_resources).toEqual([
      expect.objectContaining({
        kind: "workflow",
        id: workflow_id,
        slug: "berlin-weather",
        name: "Berlin Weather",
      }),
    ]);
    expect(capturedDraft.summary?.missing_fields).not.toContain("workflow.steps");

    const conversationRows = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conversation.id))
      .limit(1);
    expect(conversationRows[0]?.target_workflow_id).toBe(workflow_id);

    const executionAuditRows = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resource_type, "execution"));
    expect(executionAuditRows.length).toBeGreaterThan(0);

    // Contract guarantee: every run_workflow result carries a terminal
    // `status`. Without this the CLI renders "Execution status missing
    // from engine — bug, not a state" (the user's transcript).
    expect((result.data as { status: string }).status).toMatch(
      /^(succeeded|failed|partial_success)$/,
    );
  });

  test("returns status:failed when no workflow_id is resolvable", async () => {
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: {
          workflow: { name: "stub", steps: [] },
          state: {
            mode: "execution",
            stage: "workflow_executed",
            connector_mutation_seq: 0,
            workflow_mutation_seq: 0,
            checkpoints: {},
            persisted_resources: [],
            latest_execution: null,
            latest_diagnosis: null,
          },
        },
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft: conversation.draft as DraftDocument,
        setDraft: async () => {},
      }),
      // No workflow_id and no persisted active target → gate-error path.
      { environment: "dev" },
    );
    expect(result.ok).toBe(false);
    expect((result.data as { status: string }).status).toBe("failed");
    expect((result.data as { error_code: string }).error_code).toBe("workflow_not_persisted");
  });

  test("G1: pauses with an auto-generated ask_user_form when workflow declares input_schema and caller passes no input", async () => {
    // Pre-fix calling run_workflow with empty/missing input on a
    // workflow that declares input_schema ran the workflow anyway and
    // produced byte-identical output regardless of what the user
    // asked for (session ed20f48d: "run it for tomorrow" returned the
    // same 2026-05-27 forecast because the date was hardcoded in the
    // request URL and the model had no signal that an input was
    // ignored). First fix refused with an `input_required` envelope
    // the LLM had to hand-translate into a form. Now the tool pauses
    // directly with an ask_user_form synthesized from the schema; on
    // resume the LLM re-issues run_workflow with the answers.
    //
    // Seed a dedicated workflow with a unique slug to avoid colliding
    // with other tests' berlin-weather row in the shared test tenant.
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "g1-input-required",
        name: "G1 Input Required",
        lifecycle: "active",
      })
      .returning();
    if (!workflow) throw new Error("workflow insert failed");
    const [version] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: workflow.id,
        version: 1,
        dag: {
          name: "G1 Input Required",
          slug: "g1-input-required",
          input_schema: {
            type: "object",
            required: ["date"],
            properties: { date: { type: "string" } },
          },
          steps: [
            {
              id: "shape",
              kind: "transform",
              expression: "return { date: input.input.date };",
              language: "javascript",
            },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("version insert failed");
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, workflow.id));
    const workflow_id = workflow.id;
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: {
          workflow: { name: "new-workflow", steps: [] },
          state: {
            mode: "execution",
            stage: "workflow_executed",
            connector_mutation_seq: 0,
            workflow_mutation_seq: 0,
            checkpoints: {},
            persisted_resources: [],
            latest_execution: null,
            latest_diagnosis: null,
          },
        },
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft: conversation.draft as DraftDocument,
        setDraft: async () => {},
      }),
      { workflow: workflow_id, environment: "dev" /* no input */ },
    );
    expect(result.ok).toBe(true);
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_form");
    const pauseInput = result.pause?.input as {
      question: string;
      fields: Array<{ name: string; type: string; required: boolean }>;
    };
    expect(pauseInput.question).toContain("g1-input-required");
    expect(pauseInput.fields).toEqual([
      expect.objectContaining({ name: "date", type: "text", required: true }),
    ]);
    // The harness executes the run on submit (auto-persist run_workflow
    // intent) — the LLM is not trusted to re-issue with the answers.
    const intent = (result.pause?.input as { commit_intent?: Record<string, unknown> })
      .commit_intent;
    expect(intent).toMatchObject({
      kind: "run_workflow",
      payload: expect.objectContaining({ environment: "dev" }),
    });
    expect((result.data as { status: string }).status).toBe("awaiting_input");
  });

  test("pauses with the auto-form when the input contract is SYNTHESIZED from placeholders (no declared input_schema)", async () => {
    // The gate reads the same contract source the `wf_<slug>` tool
    // schema and the usage block read: declared input_schema when
    // present, else the schema synthesized from `${input.*}` /
    // `$input.*` references. Pre-fix a placeholder-driven workflow
    // without a declared schema skipped the gate entirely and failed at
    // runtime with "$input: required field '<k>' is missing" (live
    // get-jira-ticket-details run, 2026-06-11).
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "synth-input-gate",
        name: "Synth Input Gate",
        lifecycle: "active",
      })
      .returning();
    if (!workflow) throw new Error("workflow insert failed");
    const [version] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: workflow.id,
        version: 1,
        dag: {
          name: "Synth Input Gate",
          slug: "synth-input-gate",
          // NO input_schema — the contract comes from the $input ref.
          steps: [
            {
              id: "shape",
              kind: "transform",
              expression: "return { ticket: input.input.ticket_key };",
              language: "javascript",
            },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("version insert failed");
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, workflow.id));
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: {
          workflow: { name: "new-workflow", steps: [] },
          state: {
            mode: "execution",
            stage: "workflow_executed",
            connector_mutation_seq: 0,
            workflow_mutation_seq: 0,
            checkpoints: {},
            persisted_resources: [],
            latest_execution: null,
            latest_diagnosis: null,
          },
        },
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft: conversation.draft as DraftDocument,
        setDraft: async () => {},
      }),
      { workflow: workflow.id, environment: "dev" /* no input */ },
    );
    expect(result.ok).toBe(true);
    expect(result.pause?.tool_name).toBe("ask_user_form");
    const pauseInput = result.pause?.input as {
      fields: Array<{ name: string; type: string; required: boolean }>;
    };
    expect(pauseInput.fields).toEqual([
      expect.objectContaining({ name: "ticket_key", type: "text", required: true }),
    ]);
  });
});
