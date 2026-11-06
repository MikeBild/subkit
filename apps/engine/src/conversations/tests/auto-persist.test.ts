import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog, conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist/index.ts";
import {
  createCarrierElicitation,
  ctx,
  tenant_id,
  useAutoPersistSetup,
} from "./auto-persist-fixtures.ts";

useAutoPersistSetup();

const principal_id = createDeterministicUuidFactory(314)();

async function seedRenderWorkflow(
  slug = "render-upload-slides-autopersist",
  inputSchema?: Record<string, unknown>,
): Promise<{ workflow_id: string; slug: string }> {
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id,
      slug,
      name: "render-upload-slides",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: "render-upload-slides",
        slug,
        input_schema: inputSchema ?? {
          type: "object",
          required: ["markdown", "filename"],
          properties: {
            markdown: { type: "string" },
            filename: { type: "string" },
            theme: { type: "string" },
          },
        },
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression:
              "return { filename: input.input.filename, theme: input.input.theme, markdown: input.input.markdown, confirmed: input.input.confirmed ?? null };",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("workflow version insert failed");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return { workflow_id: workflow.id, slug };
}

describe("auto-persist on confirmation — save_connector_draft", () => {
  test("ask_user_confirm with run_workflow commit_intent executes with preserved input", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow();
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        question: "Run render-upload-slides?",
        kind: "external_write",
        commit_intent: {
          kind: "run_workflow",
          payload: {
            workflow: workflow.slug,
            environment: "dev",
            input_partial: {
              markdown: "# Slides\n\nBody",
              filename: "slides-grundlagen-neutral.html",
              theme: "light",
            },
          },
          description: "Run render-upload-slides.",
        },
      },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "system_account",
        id: principal_id,
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.error_code).toBeUndefined();
    expect(dispatch.synthetic_result?.tool).toBe("run_workflow");
    const [approvalAudit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, AuditAction.CONVERSATION_RESUMED),
          eq(auditLog.resource_id, elicitation.id),
        ),
      )
      .limit(1);
    expect(approvalAudit).toEqual({ actor_type: "system_account", actor_id: principal_id });
    const data = dispatch.synthetic_result?.data as {
      workflow_id: string;
      workflow_slug: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };
    expect(data.workflow_id).toBe(workflow.workflow_id);
    expect(data.workflow_slug).toBe(workflow.slug);
    expect(data.input).toEqual({
      markdown: "# Slides\n\nBody",
      filename: "slides-grundlagen-neutral.html",
      theme: "light",
    });
    expect(data.input).not.toHaveProperty("confirmed");
    expect(data.output).toMatchObject({
      filename: "slides-grundlagen-neutral.html",
      theme: "light",
      markdown: "# Slides\n\nBody",
      confirmed: null,
    });
  });

  test("ask_user_confirm with run_workflow commit_intent parses JSON-string input", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow("render-upload-slides-json-input");
    const input = {
      markdown: "# Slides\n\nBody",
      filename: "slides-grundlagen-neutral.html",
      theme: "light",
    };
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        question: "Run render-upload-slides?",
        kind: "external_write",
        commit_intent: {
          kind: "run_workflow",
          payload: {
            workflow: workflow.slug,
            environment: "dev",
            input_partial: JSON.stringify(input),
          },
          description: "Run render-upload-slides.",
        },
      },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: principal_id,
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.error_code).toBeUndefined();
    const data = dispatch.synthetic_result?.data as {
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };
    expect(data.input).toEqual(input);
    expect(data.output).toMatchObject({ ...input, confirmed: null });
  });

  test("ask_user_confirm with run_workflow commit_intent merges the confirmed input_file beneath explicit input", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow("render-upload-slides-input-file");
    const content = JSON.stringify({
      markdown: "# From file",
      filename: "from-file.html",
      theme: "dark",
    });
    const attachment = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "workflow-input.json",
      content,
    });
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        question: "Run render-upload-slides?",
        kind: "external_write",
        commit_intent: {
          kind: "run_workflow",
          payload: {
            workflow: workflow.slug,
            environment: "dev",
            input_partial: { theme: "light" },
            input_file: {
              id: attachment.file_id,
              sha256: createHash("sha256").update(content).digest("hex"),
            },
          },
          description: "Run render-upload-slides.",
        },
      },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: principal_id,
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.error_code).toBeUndefined();
    const data = dispatch.synthetic_result?.data as { input: Record<string, unknown> };
    expect(data.input).toEqual({
      markdown: "# From file",
      filename: "from-file.html",
      theme: "light",
    });
  });

  test("run_workflow auto-dispatch with a missing structured field tells the model not to ask the person", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow("support-send-structured-input", {
      type: "object",
      required: ["description", "parts", "manifest"],
      properties: {
        description: { type: "string" },
        parts: { type: "array" },
        manifest: { type: "object" },
      },
    });
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        question: "Send the report?",
        kind: "external_write",
        commit_intent: {
          kind: "run_workflow",
          payload: {
            workflow: workflow.slug,
            environment: "dev",
            input_partial: { description: "Synthetic test" },
          },
          description: "Send the report.",
        },
      },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: principal_id,
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.synthetic_result?.error_code).toBe("missing_workflow_input");
    expect(dispatch.synthetic_result?.data).toMatchObject({
      missing_fields: ["parts", "manifest"],
      structured_fields: ["parts", "manifest"],
    });
    expect(dispatch.synthetic_result?.message).toContain("never ask the user");
    expect(dispatch.synthetic_result?.message).toContain("input_file");
    expect(dispatch.synthetic_result?.message).not.toContain("ask_user_form");
  });

  test("run_workflow auto-dispatch with a REQUIRED field missing returns a directive error (not input_schema_violation)", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow("render-upload-slides-missing-field");
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Provide the inputs to run render-upload-slides",
        fields: [
          { name: "markdown", label: "markdown", type: "text", required: true },
          { name: "filename", label: "filename", type: "text", required: true },
        ],
        commit_intent: {
          kind: "run_workflow",
          payload: { workflow: workflow.slug, environment: "dev", input_partial: {} },
          description: "Run render-upload-slides.",
        },
      },
      output: { values: { filename: "slides.html" } },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: principal_id,
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { values: { filename: "slides.html" } },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(false);
    expect(dispatch.synthetic_result?.error_code).toBe("missing_workflow_input");
    expect(dispatch.synthetic_result?.message).toContain("markdown");
    expect(dispatch.synthetic_result?.message).toContain("ask_user_form");
    expect(dispatch.synthetic_result?.message).not.toContain("input_schema_violation");
    const data = dispatch.synthetic_result?.data as {
      missing_fields: string[];
      required_fields: string[];
    };
    expect(data.missing_fields).toEqual(["markdown"]);
    expect(data.required_fields.sort()).toEqual(["filename", "markdown"]);
  });

  test("run_workflow auto-dispatch with ALL required fields present dispatches the run", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow("render-upload-slides-all-fields");
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Provide the inputs to run render-upload-slides",
        fields: [
          { name: "markdown", label: "markdown", type: "text", required: true },
          { name: "filename", label: "filename", type: "text", required: true },
        ],
        commit_intent: {
          kind: "run_workflow",
          payload: { workflow: workflow.slug, environment: "dev", input_partial: {} },
          description: "Run render-upload-slides.",
        },
      },
      output: { values: { markdown: "# Slides", filename: "slides.html" } },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: principal_id,
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { values: { markdown: "# Slides", filename: "slides.html" } },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.error_code).toBeUndefined();
    expect(dispatch.synthetic_result?.tool).toBe("run_workflow");
    const data = dispatch.synthetic_result?.data as {
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };
    expect(data.input).toMatchObject({ markdown: "# Slides", filename: "slides.html" });
    expect(data.output).toMatchObject({ markdown: "# Slides", filename: "slides.html" });
  });
});
