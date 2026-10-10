import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../tools/index.ts";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  conversations,
  executions,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import { bindPersistedWorkflow } from "../authoring-state.ts";
import { loadDraft } from "../draft.ts";
import { runWorkflowTool } from "../tools/engine-api/writes/run-workflow.ts";
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

async function seedWorkflow(slug = "berlin-weather"): Promise<{
  workflow_id: string;
  version_id: string;
}> {
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
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
        slug,
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
  afterWorkflowRead?: (id: string) => Promise<void>;
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
        const workflow = await getWorkflow(ctx.tenant_id, id, ctx.testDb.db);
        await params.afterWorkflowRead?.(id);
        return workflow;
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
  test("refuses a prepared run when its exact version is no longer active", async () => {
    const { workflow_id, version_id } = await seedWorkflow("prepared-version-stale");
    const [replacement] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id,
        version: 2,
        dag: {
          name: "Replacement",
          slug: "prepared-version-stale",
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { replacement: true };",
            },
          ],
        },
      })
      .returning();
    if (!replacement) throw new Error("replacement insert failed");
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: replacement.id })
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflow_id)));
    const draft: DraftDocument = { workflow: { name: "stub", steps: [] } };
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", draft })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    const result = await runWorkflowTool.execute(
      buildToolCtx({ conversation_id: conversation.id, draft, setDraft: async () => {} }),
      runWorkflowTool.inputSchema.parse({
        workflow: workflow_id,
        environment: "dev",
        input: { date: "approved input" },
        expected_workflow_version_id: version_id,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      error_code: "workflow_version_not_active",
      expected_workflow_version_id: version_id,
      current_workflow_version_id: replacement.id,
    });
    const runs = await ctx.testDb.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
    expect(runs).toEqual([]);
  });

  test("pins the inspected version when activation changes before execution", async () => {
    const { workflow_id, version_id } = await seedWorkflow("activation-race");
    const [replacement] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id,
        version: 2,
        dag: {
          name: "Replacement",
          slug: "activation-race",
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { unexpected: true };",
            },
          ],
        },
      })
      .returning();
    if (!replacement) throw new Error("replacement insert failed");
    const draft: DraftDocument = { workflow: { name: "stub", steps: [] } };
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", draft })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft,
        setDraft: async () => {},
        afterWorkflowRead: async (id) => {
          await ctx.testDb.db
            .update(workflows)
            .set({ current_version_id: replacement.id })
            .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, id)));
        },
      }),
      runWorkflowTool.inputSchema.parse({
        workflow: workflow_id,
        input: { date: "approved input" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ output: { date: "approved input" } });
    const runs = await ctx.testDb.db
      .select({ version: executions.workflow_version_id })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
    expect(runs).toEqual([{ version: version_id }]);
  });

  for (const fixture of ["new-bound", "new-unbound", "edited-active"] as const) {
    test(`requires activation for an inert ${fixture} draft and starts no execution`, async () => {
      const saved = await saveWorkflowDraft(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          request_source: "chat",
          def: {
            name: `Activation ${fixture}`,
            slug: `activation-${fixture}`,
            steps: [
              {
                id: "shape",
                kind: "transform",
                language: "javascript",
                expression: "return { draft: true };",
              },
            ],
          },
        },
        ctx.testDb.db,
      );
      if (!saved.draft) throw new Error(saved.errors.join("; "));
      let currentVersionId: string | null = null;
      if (fixture === "edited-active") {
        const [active] = await ctx.testDb.db
          .insert(workflowVersions)
          .values({
            tenant_id: ctx.tenant_id,
            workflow_id: saved.draft.workflow_id,
            version: 2,
            dag: {
              ...saved.draft.definition,
              steps: [
                {
                  id: "shape",
                  kind: "transform",
                  language: "javascript",
                  expression: "return { old: true };",
                },
              ],
            },
          })
          .returning();
        if (!active) throw new Error("active fixture insert failed");
        currentVersionId = active.id;
        await ctx.testDb.db
          .update(workflows)
          .set({ current_version_id: active.id, lifecycle: "active" })
          .where(
            and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, saved.draft.workflow_id)),
          );
      }
      const emptyDraft: DraftDocument = { workflow: { name: "stub", steps: [] } };
      const draft =
        fixture === "new-unbound"
          ? emptyDraft
          : bindPersistedWorkflow(emptyDraft, {
              kind: "workflow",
              id: saved.draft.workflow_id,
              slug: saved.draft.definition.slug ?? null,
              name: saved.draft.definition.name,
              version_id: saved.draft.version_id,
              version: saved.draft.version,
              environment: null,
              saved_at: "2026-05-01T00:00:00.000Z",
              draft_version_id: saved.draft.version_id,
              current_version_id: currentVersionId,
              persistence_kind: "draft",
            });
      const [conversation] = await ctx.testDb.db
        .insert(conversations)
        .values({ tenant_id: ctx.tenant_id, status: "active", draft })
        .returning();
      if (!conversation) throw new Error("conversation insert failed");
      let draftWrites = 0;
      const result = await runWorkflowTool.execute(
        buildToolCtx({
          conversation_id: conversation.id,
          draft,
          setDraft: async () => {
            draftWrites++;
          },
        }),
        runWorkflowTool.inputSchema.parse({
          workflow: saved.draft.workflow_id,
          execute_writes: true,
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.data).toMatchObject({
        status: "failed",
        error_code: "workflow_activation_required",
        draft_version_id: saved.draft.version_id,
        current_version_id: currentVersionId,
        next_best_actions: ["dry_run_workflow"],
      });
      expect((result.data as { message: string }).message).toContain("dry_run_workflow");
      expect(draftWrites).toBe(0);
      const runs = await ctx.testDb.db
        .select({ id: executions.id })
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, ctx.tenant_id),
            eq(executions.workflow_id, saved.draft.workflow_id),
          ),
        );
      expect(runs).toEqual([]);
    });
  }

  test("an empty conversation adopts the workflow it runs, definition included, and normalizes stringified input", async () => {
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
      runWorkflowTool.inputSchema.parse({
        workflow: workflow_id,
        environment: "dev",
        input: '{"date":"tomorrow +1"}',
      }),
    );

    expect(result.ok).toBe(true);
    if (!nextDraft) throw new Error("next draft was not captured");
    const capturedDraft = nextDraft as DraftDocument;
    expect(capturedDraft.workflow.name).toBe("Berlin Weather");
    expect(capturedDraft.workflow.steps.map((step) => step.id)).toEqual(["shape"]);
    expect(capturedDraft.summary?.persisted_resources).toEqual([
      expect.objectContaining({ kind: "workflow", id: workflow_id, slug: "berlin-weather" }),
    ]);
    expect(capturedDraft.latest_preview?.summary).toContain("run_workflow finished");
    expect(capturedDraft.state?.latest_execution?.workflow_id).toBe(workflow_id);

    const conversationRows = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conversation.id))
      .limit(1);
    expect(conversationRows[0]?.target_workflow_id).toBe(workflow_id);

    const again = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft: capturedDraft,
        setDraft: async () => {},
      }),
      runWorkflowTool.inputSchema.parse({ environment: "dev", input: '{"date":"today"}' }),
    );
    expect(again.ok).toBe(true);
    expect((again.data as { workflow_id: string }).workflow_id).toBe(workflow_id);

    const executionAuditRows = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resource_type, "execution"));
    expect(executionAuditRows.length).toBeGreaterThan(0);

    expect((result.data as { status: string }).status).toMatch(
      /^(succeeded|failed|partial_success)$/,
    );
    expect(result.data).not.toHaveProperty("error");
    expect((result.data as { output: { date?: unknown } }).output).toMatchObject({
      date: "tomorrow +1",
    });
  });

  test("running another workflow keeps the workflow the conversation is editing", async () => {
    const edited = await seedWorkflow("edited-in-chat");
    const other = await seedWorkflow("run-from-chat");
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        target_workflow_id: edited.workflow_id,
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    const draft = await loadDraft(ctx.tenant_id, conversation.id, ctx.testDb.db);
    let nextDraft: DraftDocument | null = null;
    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft,
        setDraft: async (next) => {
          nextDraft = next;
        },
      }),
      runWorkflowTool.inputSchema.parse({
        workflow: other.workflow_id,
        environment: "dev",
        input: '{"date":"today"}',
      }),
    );

    expect(result.ok).toBe(true);
    const recorded = nextDraft as DraftDocument | null;
    expect(recorded?.summary?.active_target?.id).toBe(edited.workflow_id);
    expect(recorded?.state?.latest_execution?.workflow_id).toBe(other.workflow_id);
    const [row] = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(row?.target_workflow_id).toBe(edited.workflow_id);
  });

  test("a tolerated on_error=continue failure stays succeeded and surfaces step_failed_continued", async () => {
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "continue-tolerated",
        name: "Continue Tolerated",
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
          name: "Continue Tolerated",
          slug: "continue-tolerated",
          steps: [
            {
              id: "boom",
              kind: "transform",
              expression: "throw new Error('tolerated failure');",
              language: "javascript",
              on_error: "continue",
            },
            {
              id: "shape",
              kind: "transform",
              expression: "return { ok: true };",
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
      runWorkflowTool.inputSchema.parse({
        workflow: workflow.id,
        environment: "dev",
      }),
    );

    expect(result.ok).toBe(true);
    const data = result.data as {
      status: string;
      warnings?: Array<{ code: string; step_key?: string }>;
      diagnosis_available?: boolean;
      requires_repair?: boolean;
    };
    expect(data.status).toBe("succeeded");
    expect(result.data).not.toHaveProperty("error");
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "step_failed_continued", step_key: "boom" }),
      ]),
    );
    expect(data.diagnosis_available).toBe(true);
    expect(data.requires_repair).toBe(false);
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
      { environment: "dev" },
    );
    expect(result.ok).toBe(false);
    expect((result.data as { status: string }).status).toBe("failed");
    expect((result.data as { error_code: string }).error_code).toBe("workflow_not_persisted");
  });

  test("G1: pauses with an auto-generated ask_user_form when workflow declares input_schema and caller passes no input", async () => {
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
      { workflow: workflow_id, environment: "dev" },
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
    const intent = (result.pause!.input as { commit_intent?: Record<string, unknown> })
      .commit_intent;
    expect(intent).toMatchObject({
      kind: "run_workflow",
      payload: expect.objectContaining({ environment: "dev" }),
    });
    expect((result.data as { status: string }).status).toBe("awaiting_input");
  });

  test("pauses with the auto-form when the input contract is SYNTHESIZED from placeholders (no declared input_schema)", async () => {
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
      { workflow: workflow.id, environment: "dev" },
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

  test("multi-field synthesized contract (multipart upload) → ask_user_form carries BOTH fields, never a single free-text ask", async () => {
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "render-upload-multipart",
        name: "Render Upload Multipart",
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
          name: "Render Upload Multipart",
          slug: "render-upload-multipart",
          steps: [
            {
              id: "upload",
              kind: "request",
              method: "POST",
              url: "https://files.example.test/upload",
              multipart: [
                {
                  name: "file",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
                  value: "${input.markdown}",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
                  filename: "${input.filename}",
                },
              ],
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
      { workflow: workflow.id, environment: "dev" },
    );
    expect(result.ok).toBe(true);
    expect(result.pause?.tool_name).toBe("ask_user_form");
    const pauseInput = result.pause?.input as {
      fields: Array<{ name: string; type: string; required: boolean }>;
    };
    const fieldNames = pauseInput.fields.map((f) => f.name).sort();
    expect(fieldNames).toEqual(["filename", "markdown"]);
    for (const f of pauseInput.fields) {
      expect(f).toMatchObject({ type: "text", required: true });
    }
  });

  test("W4: a SAVED workflow carrying input_schema_sample resolves the payload-derived contract end-to-end", async () => {
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "render-upload-slides-sample",
        name: "Render Upload Slides (sample)",
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
          name: "Render Upload Slides (sample)",
          slug: "render-upload-slides-sample",
          input_schema_sample: { markdown: "# Slides", filename: "deck.md" },
          steps: [
            {
              id: "upload",
              kind: "request",
              method: "POST",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
              url: "https://files.example.test/upload/${input.filename}",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
              body: { content: "${input.markdown}" },
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
      { workflow: workflow.id, environment: "dev" },
    );
    expect(result.ok).toBe(true);
    expect(result.pause?.tool_name).toBe("ask_user_form");
    const pauseInput = result.pause?.input as {
      fields: Array<{ name: string; type: string; required: boolean }>;
    };
    const fieldNames = pauseInput.fields.map((f) => f.name).sort();
    expect(fieldNames).toEqual(["filename", "markdown"]);
    for (const f of pauseInput.fields) {
      expect(f).toMatchObject({ required: true });
    }
  });

  test("W4 no-regression: the SAME saved workflow WITHOUT a sample yields only the structurally-synthesized key", async () => {
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "render-upload-slides-no-sample",
        name: "Render Upload Slides (no sample)",
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
          name: "Render Upload Slides (no sample)",
          slug: "render-upload-slides-no-sample",
          steps: [
            {
              id: "upload",
              kind: "request",
              method: "POST",
              url: "https://files.example.test/upload",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
              body: { content: "${input.markdown}" },
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
      { workflow: workflow.id, environment: "dev" },
    );
    expect(result.ok).toBe(true);
    expect(result.pause?.tool_name).toBe("ask_user_form");
    const pauseInput = result.pause?.input as {
      fields: Array<{ name: string; type: string; required: boolean }>;
    };
    expect(pauseInput.fields.map((f) => f.name)).toEqual(["markdown"]);
  });
});
