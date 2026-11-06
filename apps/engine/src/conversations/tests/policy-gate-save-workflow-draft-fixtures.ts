import { afterAll, beforeAll } from "bun:test";
import { conversations } from "../../db/schema/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state/index.ts";
import type { DraftDocument } from "../types.ts";

export let ctx: LlmTestCtx;

export async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("failed to seed conversation");
  return row.id;
}

export function readyWorkflowDraft(slug: string): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: slug,
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          language: "javascript",
          expression: "return input.input;",
        },
      ],
    },
  };
  const inspected = withWorkflowInspection(base);
  const validated = withWorkflowValidation(inspected, true, "Workflow draft validated.");
  return withLatestPreview(validated, {
    ok: true,
    summary: "preview ok",
    warnings: [],
  });
}

export function usePolicyGateSaveWorkflowDraftSetup(): void {
  beforeAll(async () => {
    ctx = await createLlmTestCtx("policy-gate-save-workflow-draft");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });
}
