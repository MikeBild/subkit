import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../../apps/engine/src/conversations/authoring-state.ts";
import {
  conversationDrafts,
  conversations,
  workflows,
} from "../../apps/engine/src/db/schema/index.ts";
import { getMockProvider } from "../../apps/engine/src/llm/mock-provider.ts";
import { boot, cli, type E2EEnv, parseJson, shutdown } from "./setup.ts";

let env: E2EEnv;

beforeAll(async () => {
  env = await boot("workflow-save-follow-up", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  await shutdown(env);
}, 30_000);

function readyDraft() {
  let draft = withWorkflowDraft(createEmptyDraftDocument(), {
    name: "GitHub Private Repos by Owner",
    slug: "github-private-repos-octocat",
    steps: [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input.input;" },
    ],
  });
  draft = withWorkflowInspection(draft);
  draft = withWorkflowValidation(draft, true, "Workflow draft valid.");
  draft = withLatestPreview(draft, {
    ok: true,
    step_id: "shape",
    summary: "Preview ok.",
  });
  return {
    ...draft,
    session: { permission_mode: "auto" as const },
  };
}

async function seedConversation(): Promise<string> {
  const draft = readyDraft();
  const [conversation] = await env.db
    .insert(conversations)
    .values({
      tenant_id: env.tenantId,
      status: "active",
      owner_id: env.personas.admin.userId,
      draft: draft as unknown as Record<string, unknown>,
    })
    .returning();
  if (!conversation) throw new Error("conversation insert failed");
  await env.db.insert(conversationDrafts).values({
    tenant_id: env.tenantId,
    conversation_id: conversation.id,
    ordinal: "000001",
    snapshot: draft as unknown as Record<string, unknown>,
  });
  return conversation.id;
}

async function getDetail(conversationId: string): Promise<{
  conversation: { target_workflow_id: string | null; status: string };
  tool_calls: Array<{ tool: string }>;
}> {
  const response = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, {
    headers: {
      Authorization: `Bearer ${env.personas.admin.apiKey}`,
    },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    conversation: { target_workflow_id: string | null; status: string };
    tool_calls: Array<{ tool: string }>;
  };
}

describe("ready workflow saves stay deterministic in auto mode", () => {
  test("a short yes follow-up saves an inert draft without an extra confirm stall", async () => {
    const conversationId = await seedConversation();

    getMockProvider().setConversePlan(conversationId, [{ tool: "save_workflow_draft", args: {} }]);

    const result = await cli(["--r", conversationId, "--p", "yes", "--output", "json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expect(result.exitCode).toBe(0);
    const body = parseJson<{
      status: string;
      assistant_text: string;
      committed_workflow_id?: string;
    }>(result);
    expect(body.status).toBe("completed");
    expect(body.committed_workflow_id).toBeTruthy();
    expect(body.assistant_text).not.toContain("approve");
    expect(body.assistant_text).not.toContain("confirm");

    const detail = await getDetail(conversationId);
    expect(detail.conversation.status).toBe("active");
    expect(detail.conversation.target_workflow_id).toBe(body.committed_workflow_id);
    expect(detail.tool_calls.map((call) => call.tool)).toContain("save_workflow_draft");
    expect(detail.tool_calls.map((call) => call.tool)).not.toContain("cannot_help");

    const workflowRows = await env.db
      .select({
        id: workflows.id,
        current_version_id: workflows.current_version_id,
        draft_version_id: workflows.draft_version_id,
      })
      .from(workflows)
      .where(eq(workflows.id, body.committed_workflow_id!));
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]!.current_version_id).toBeNull();
    expect(workflowRows[0]!.draft_version_id).toBeTruthy();
  }, 120_000);
});
