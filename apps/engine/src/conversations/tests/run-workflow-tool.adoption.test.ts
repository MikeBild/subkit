import { describe, expect, test } from "bun:test";
import "../tools/index.ts";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { loadDraft } from "../draft.ts";
import { runWorkflowTool } from "../tools/engine-api/writes/run-workflow.ts";
import { loadWorkflowInputFile } from "../tools/workflow-file-input.ts";
import type { DraftDocument } from "../types.ts";
import {
  buildToolCtx,
  ctx,
  seedWorkflow,
  useRunWorkflowToolSetup,
} from "./run-workflow-tool-fixtures.ts";

useRunWorkflowToolSetup();

describe("run_workflow tool", () => {
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

  test("file input is conversation-scoped and verified before workflow execution", async () => {
    const saved = await seedWorkflow("file-input-workflow");
    const [conversation, other] = await ctx.testDb.db
      .insert(conversations)
      .values([
        { tenant_id: ctx.tenant_id, status: "active" },
        { tenant_id: ctx.tenant_id, status: "active" },
      ])
      .returning();
    if (!conversation || !other) throw new Error("conversation insert failed");
    const content = JSON.stringify({ date: "from-file" });
    const attachment = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      filename: "workflow-input.json",
      content,
    });
    const source = {
      id: attachment.file_id,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const draft = await loadDraft(ctx.tenant_id, conversation.id, ctx.testDb.db);
    const toolCtx = buildToolCtx({
      conversation_id: conversation.id,
      draft,
      setDraft: async () => {},
    });
    await expect(
      loadWorkflowInputFile({ ...toolCtx, conversation_id: other.id }, source),
    ).rejects.toThrow("not available");
    await expect(
      loadWorkflowInputFile(toolCtx, { ...source, sha256: "0".repeat(64) }),
    ).rejects.toThrow("not available");
    const result = await runWorkflowTool.execute(
      toolCtx,
      runWorkflowTool.inputSchema.parse({
        workflow: saved.workflow_id,
        input_file: source,
        input: { date: "explicit-override" },
        preserve_draft: true,
      }),
    );
    expect(result.ok).toBe(true);
    expect((result.data as { output: unknown }).output).toEqual({ date: "explicit-override" });
  });

  test("auxiliary execution preserves the complete authoring draft on request", async () => {
    const edited = await seedWorkflow("preserved-draft");
    const other = await seedWorkflow("auxiliary-run");
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
    const original = structuredClone(draft);
    let updates = 0;
    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft,
        setDraft: async () => {
          updates += 1;
        },
      }),
      runWorkflowTool.inputSchema.parse({
        workflow: other.workflow_id,
        input: { date: "today" },
        preserve_draft: true,
      }),
    );
    expect(result.ok).toBe(true);
    expect(updates).toBe(0);
    expect(draft).toEqual(original);
    const [row] = await ctx.testDb.db
      .select({ target: conversations.target_workflow_id })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation.id)),
      );
    expect(row?.target).toBe(edited.workflow_id);
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
});
