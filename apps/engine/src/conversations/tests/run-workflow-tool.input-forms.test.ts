import { describe, expect, test } from "bun:test";
import "../tools/index.ts";
import { eq } from "drizzle-orm";
import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { runWorkflowTool } from "../tools/engine-api/writes/run-workflow.ts";
import type { DraftDocument } from "../types.ts";
import { buildToolCtx, ctx, useRunWorkflowToolSetup } from "./run-workflow-tool-fixtures.ts";

useRunWorkflowToolSetup();

describe("run_workflow tool", () => {
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
            properties: { date: { type: "string", title: "Welches Datum?" } },
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
      expect.objectContaining({
        name: "date",
        label: "Welches Datum?",
        type: "text",
        required: true,
      }),
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
    const partial = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft: conversation.draft as DraftDocument,
        setDraft: async () => {},
      }),
      { workflow: workflow.id, environment: "dev", input: { filename: "report.txt" } },
    );
    expect(
      (partial.pause!.input as { fields: Array<{ name: string }> }).fields.map(
        (field) => field.name,
      ),
    ).toEqual(["markdown"]);
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
