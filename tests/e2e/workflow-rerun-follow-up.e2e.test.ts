import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversations,
  workflows,
  workflowVersions,
} from "../../apps/engine/src/db/schema/index.ts";
import { getMockProvider } from "../../apps/engine/src/llm/mock-provider.ts";
import { boot, cli, type E2EEnv, parseJson, shutdown } from "./setup.ts";

let env: E2EEnv;

beforeAll(async () => {
  env = await boot("workflow-rerun-follow-up", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  await shutdown(env);
}, 30_000);

function bearer(): HeadersInit {
  return {
    Authorization: `Bearer ${env.personas.admin.apiKey}`,
    "Content-Type": "application/json",
  };
}

async function seedWorkflow(): Promise<string> {
  const [workflow] = await env.db
    .insert(workflows)
    .values({
      tenant_id: env.tenantId,
      slug: "berlin-weather",
      name: "Berlin Weather",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("seed workflow failed");
  const [version] = await env.db
    .insert(workflowVersions)
    .values({
      tenant_id: env.tenantId,
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
            expression: '{ "date": $input.date }',
            language: "jsonata",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("seed workflow version failed");
  await env.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return workflow.id;
}

async function createConversation(workflowId: string): Promise<string> {
  const response = await fetch(`${env.baseUrl}/v1/conversations`, {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify({
      workflow_id: workflowId,
      title: "workflow-rerun-follow-up",
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    conversation: { id: string };
  };
  return body.conversation.id;
}

async function getDetail(conversationId: string): Promise<{
  conversation: { target_workflow_id: string | null };
  draft: {
    summary?: {
      active_target?: { kind: string; id: string | null };
      latest_execution?: { workflow_id: string | null; status: string };
    };
  } | null;
  tool_calls: Array<{ tool: string }>;
}> {
  const response = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, {
    headers: bearer(),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    conversation: { target_workflow_id: string | null };
    draft: {
      summary?: {
        active_target?: { kind: string; id: string | null };
        latest_execution?: { workflow_id: string | null; status: string };
      };
    } | null;
    tool_calls: Array<{ tool: string }>;
  };
}

describe("saved workflow reruns stay on the sk conversation surface", () => {
  test("run + rerun keeps the saved workflow bound and avoids cannot_help fallbacks", async () => {
    const workflowId = await seedWorkflow();
    const conversationId = await createConversation(workflowId);

    getMockProvider().setConversePlan(conversationId, [
      {
        tool: "run_workflow",
        args: {
          workflow_id: workflowId,
          environment: "dev",
          input: { date: "tomorrow" },
        },
      },
    ]);
    const firstRun = await cli(
      ["--r", conversationId, "--p", "run berlin-weather for tomorrow", "--output", "json"],
      { env, persona: "admin", timeout: 60_000 },
    );
    expect(firstRun.exitCode).toBe(0);
    const firstRunBody = parseJson<{
      status: string;
      assistant_text: string;
    }>(firstRun);
    expect(firstRunBody.status).toBe("completed");
    expect(firstRunBody.assistant_text).not.toContain("sk workflow run");
    expect(firstRunBody.assistant_text).not.toContain("http://");

    const afterFirstRun = await getDetail(conversationId);
    expect(afterFirstRun.tool_calls.map((call) => call.tool)).toContain("run_workflow");
    expect(afterFirstRun.tool_calls.map((call) => call.tool)).not.toContain("cannot_help");
    expect(afterFirstRun.conversation.target_workflow_id).toBe(workflowId);
    expect(afterFirstRun.draft?.summary?.active_target).toEqual(
      expect.objectContaining({
        kind: "workflow",
        id: workflowId,
      }),
    );
    expect(afterFirstRun.draft?.summary?.latest_execution?.workflow_id).toBe(workflowId);

    getMockProvider().setConversePlan(conversationId, [
      {
        tool: "run_workflow",
        args: {
          workflow_id: workflowId,
          environment: "dev",
          input: { date: "tomorrow +1" },
        },
      },
    ]);
    const secondRun = await cli(
      [
        "--r",
        conversationId,
        "--p",
        'run berlin-weather for tomorrow +1 ("the day after tomorrow")',
        "--output",
        "json",
      ],
      { env, persona: "admin", timeout: 60_000 },
    );
    expect(secondRun.exitCode).toBe(0);
    const secondRunBody = parseJson<{
      status: string;
      assistant_text: string;
    }>(secondRun);
    expect(secondRunBody.status).toBe("completed");
    expect(secondRunBody.assistant_text).not.toContain("sk workflow run");
    expect(secondRunBody.assistant_text).not.toContain("http://");

    const finalDetail = await getDetail(conversationId);
    expect(finalDetail.conversation.target_workflow_id).toBe(workflowId);
    expect(finalDetail.draft?.summary?.active_target).toEqual(
      expect.objectContaining({
        kind: "workflow",
        id: workflowId,
      }),
    );
    expect(finalDetail.draft?.summary?.latest_execution?.workflow_id).toBe(workflowId);
    expect(finalDetail.tool_calls.map((call) => call.tool)).toEqual(
      expect.arrayContaining(["run_workflow"]),
    );
    expect(finalDetail.tool_calls.map((call) => call.tool)).not.toContain("cannot_help");

    const conversationRows = await env.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    expect(conversationRows[0]?.target_workflow_id).toBe(workflowId);
  }, 120_000);
});
