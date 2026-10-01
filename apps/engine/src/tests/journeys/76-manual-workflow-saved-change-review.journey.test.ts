// User story: As a person who had the chat build a manual workflow — no
// schedule, no webhook — I want the run refusal "needs your review" to come
// with the review it names, so that I can apply the saved change and run it
// instead of being sent to an API call that the product forbids.
// Acceptance criteria:
//   - AC1: In the chat, run_workflow on a saved, never-applied workflow is
//     refused with workflow_activation_required AND carries the saved-change
//     review card (the dialog the refusal promises), in the run's environment.
//     Nothing ran.
//   - AC2: review_workflow_automation shows that card for the workflow although
//     nothing starts it automatically, and the turn ends on it.
//   - AC3: Over MCP — no card, no human channel — the same refusal and review
//     hand the person a review_url on the workflow's cockpit page instead.
//   - AC4: Neither the refusal nor its recovery guidance offers an API call, a
//     command, or leaving the chat.
//   - AC5: The human applies the reviewed change over HTTP from a browser
//     session; afterwards run_workflow no longer refuses, and the review has
//     nothing left to show.
// Spec refs: docs/authors/authoring-workflows.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { bindPersistedWorkflow } from "../../conversations/authoring-state.ts";
import { ERROR_CODE_ALTERNATIVES } from "../../conversations/tools/sdk-wrap/error-recovery-hints.ts";
import { conversations, executions, sessions, workflows } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let workflowId = "";
let draftVersionId = "";

type Output = { ok?: boolean; data?: Record<string, unknown> } & Record<string, unknown>;
type TurnEvent = { type: string; tool?: string; output?: Output };

/** Unwraps the `{ ok, data }` envelope a tool result carries in the stream. */
const dataOf = (output: Output | undefined): Record<string, unknown> =>
  (output?.data ?? output ?? {}) as Record<string, unknown>;

/** One chat turn whose model step is the given tool call. */
async function chatTurn(tool: string, args: Record<string, unknown>): Promise<TurnEvent[]> {
  const created = await journeyFetch(ctx, "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ permission_mode: "auto" }),
  });
  expect(created.status).toBe(201);
  const conversationId = ((await created.json()) as { conversation: { id: string } }).conversation
    .id;
  // The chat that saved the workflow is bound to it — what its auto-commit
  // leaves on the conversation, and what puts run_workflow in the palette.
  await ctx.db
    .update(conversations)
    .set({
      draft: bindPersistedWorkflow(
        { workflow: { name: "Manual summary", steps: [] } },
        {
          kind: "workflow",
          id: workflowId,
          slug: "manual-summary",
          name: "Manual summary",
          version_id: draftVersionId,
          version: 1,
          environment: null,
          saved_at: "2026-09-30T00:00:00.000Z",
          draft_version_id: draftVersionId,
          current_version_id: null,
          persistence_kind: "draft",
        },
      ),
    })
    .where(and(eq(conversations.tenant_id, ctx.tenantId), eq(conversations.id, conversationId)));
  getMockProvider().setConversePlan(conversationId, [{ tool, args }]);
  const turn = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message: "Run my workflow" }),
  });
  expect([200, 202]).toContain(turn.status);
  return ((await turn.json()) as { events: TurnEvent[] }).events;
}

function toolResult(events: TurnEvent[], tool: string): Output | undefined {
  return events.find((e) => e.type === "tool_result" && e.tool === tool)?.output;
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${ctx.apiKey}` } },
  });
  const client = new Client({ name: "subkit-journey", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
    const envelope = JSON.parse(text) as Output & { details?: Record<string, unknown> };
    // A failed tool's own payload travels as `details` on this surface.
    return (envelope.details ? { data: envelope.details } : envelope) as Output;
  } finally {
    await client.close();
  }
}

async function runsOf(id: string) {
  return ctx.db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, id)));
}

beforeAll(async () => {
  ctx = await createJourneyCtx("saved-change-review");
  // What the chat's auto-commit leaves behind: a saved draft, never applied,
  // and nothing that starts it automatically.
  const saved = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenantId,
      actor_id: ctx.userId,
      request_source: "chat",
      def: {
        name: "Manual summary",
        slug: "manual-summary",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return { summary: 'ok' };",
          },
        ],
      },
    },
    ctx.db,
  );
  if (!saved.draft) throw new Error(saved.errors.join("; "));
  workflowId = saved.draft.workflow_id;
  draftVersionId = saved.draft.version_id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: a manual workflow's saved change has a review the person can act on", () => {
  test("AC1: the chat run refusal carries the review card it promises", async () => {
    const events = await chatTurn("run_workflow", { workflow: workflowId });
    const refusal = dataOf(toolResult(events, "run_workflow"));
    expect(refusal.error_code).toBe("workflow_activation_required");
    const review = refusal.automation_review as Record<string, unknown> | undefined;
    expect(review).toMatchObject({
      kind: "workflow_automation_review",
      presentation: "automation_readiness_card",
      workflow_id: workflowId,
      schedules: [],
      saved_change: {
        workflow_version_id: draftVersionId,
        current_version_id: null,
        environment: "dev",
        review: expect.objectContaining({ workflow_version_id: draftVersionId }),
      },
    });
    expect(await runsOf(workflowId)).toEqual([]);
  });

  test("AC2: the review shows the card although nothing starts the workflow", async () => {
    const events = await chatTurn("review_workflow_automation", { workflow_id: workflowId });
    const review = dataOf(toolResult(events, "review_workflow_automation"));
    expect(review).toMatchObject({
      kind: "workflow_automation_review",
      presentation: "automation_readiness_card",
      saved_change: { workflow_version_id: draftVersionId, environment: "dev" },
    });
  });

  test("AC3: over MCP the refusal and the review hand over the cockpit review page", async () => {
    const page = `/cockpit/workflows/${workflowId}`;
    const refusal = dataOf(await mcpCall("run_workflow", { workflow: workflowId }));
    expect(refusal.error_code).toBe("workflow_activation_required");
    expect(String(refusal.review_url)).toEndWith(page);
    expect(String(refusal.message)).toContain("review_url");
    expect(String(refusal.message)).not.toContain("shown in this chat");
    const review = dataOf(await mcpCall("review_workflow_automation", { workflow_id: workflowId }));
    expect(review.presentation).toBe("text");
    expect(String(review.review_url)).toEndWith(page);
    expect(review.saved_change).toMatchObject({ workflow_version_id: draftVersionId });
    expect(await runsOf(workflowId)).toEqual([]);
  });

  test("AC4: no API call, command or leaving the chat is offered as a way around", async () => {
    const events = await chatTurn("run_workflow", { workflow: workflowId });
    const refusal = dataOf(toolResult(events, "run_workflow"));
    const guidance = [
      String(refusal.message),
      ERROR_CODE_ALTERNATIVES.workflow_activation_required ?? "",
    ];
    for (const text of guidance) {
      expect(text).not.toMatch(/curl -|\/v1\/|POST \/|https?:\/\//);
      expect(text).toMatch(/[Nn]ever (offer|provide) an API/);
    }
  });

  test("AC5: the person applies the change; the run is no longer refused", async () => {
    const preview = await journeyFetch(
      ctx,
      `/v1/workflows/${workflowId}/versions/${draftVersionId}/authority-preview?environment=dev`,
    );
    expect(preview.status).toBe(200);
    const { digest } = (await preview.json()) as { digest: string };
    const now = await databaseNow(ctx.db);
    const [session] = await ctx.db
      .insert(sessions)
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        expires_at: new Date(now.getTime() + 3_600_000),
        absolute_expires_at: new Date(now.getTime() + 3_600_000),
      })
      .returning();
    if (!session) throw new Error("missing browser session fixture");
    const payload = { tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: session.id };
    const applied = await fetch(`${ctx.baseUrl}/v1/workflows/${workflowId}/activate-draft`, {
      method: "POST",
      headers: {
        cookie: browserSessionCookie(await signBrowserSession(payload)),
        "x-subkit-csrf": await signBrowserCsrf(payload),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workflow_version_id: draftVersionId,
        expected_current_version_id: null,
        expected_manifest_digest: digest,
        execution_environment: "dev",
      }),
    });
    expect(applied.status).toBe(200);
    const [row] = await ctx.db
      .select({ current: workflows.current_version_id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, workflowId)));
    expect(row?.current).toBe(draftVersionId);

    const events = await chatTurn("run_workflow", { workflow: workflowId });
    const run = dataOf(toolResult(events, "run_workflow"));
    expect(run.error_code).not.toBe("workflow_activation_required");
    expect(run.automation_review).toBeUndefined();

    const after = await chatTurn("review_workflow_automation", { workflow_id: workflowId });
    const review = dataOf(toolResult(after, "review_workflow_automation"));
    expect(review.saved_change).toBeNull();
    expect(review.presentation).toBe("text");
  });
});
