import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import {
  auditLog,
  conversationMessages,
  conversations,
  conversationToolCalls,
  executionSteps,
  executions,
} from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { isSensitivePayload } from "../../../execution/sensitive-payload.ts";
import { getMockProvider } from "../../../llm/mock-provider.ts";
import { logRing } from "../../../observability/log-ring.ts";
import {
  createMockServer,
  jsonResponse,
  type MockServer,
} from "../../../test-helpers/mock-http.ts";
import {
  createEmptyDraftDocument,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../../authoring-state.ts";
import { invokeConversationToolDirect } from "../../direct-invoke.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { __resetDryRunCacheForTest } from "../dry-run-cache.ts";
import { dryRunWorkflowTool } from "../dry-run-workflow.ts";
import type { ToolContext } from "../index.ts";
import { __resetLastPreviewStoreForTest, getLastPreview } from "../last-preview-store.ts";

const PLANTED = "PLANTED-conversation-sensitive-canary";
const CONVERSATION_ID = "00000000-0000-4000-8000-0000000005e1";

let ctx: ConversationTestCtx;
let mock: MockServer;
let writes = 0;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-sensitive");
  mock = await createMockServer((req, res) => {
    if (req.method !== "GET") {
      writes++;
      return jsonResponse(res, 500, { error: "write dispatched" });
    }
    jsonResponse(res, 200, {
      items: [{ name: PLANTED }, { name: PLANTED }, { name: PLANTED }],
      note: PLANTED,
    });
  });
});

afterAll(async () => {
  __resetDryRunCacheForTest();
  __resetLastPreviewStoreForTest();
  await mock.close();
  await ctx.cleanup();
});

beforeEach(() => {
  __resetDryRunCacheForTest();
  __resetLastPreviewStoreForTest();
  getMockProvider().calls = [];
});

function sensitiveWorkflow(slug: string) {
  return {
    name: slug,
    slug,
    execution_privacy: "sensitive" as const,
    output_schema: {
      type: "object",
      properties: { names: { type: "array" }, count: { type: "number" } },
      required: ["names", "count"],
    },
    validation_function: "return input.count > 0;",
    steps: [
      {
        id: "read",
        kind: "request",
        method: "GET",
        url: `${mock.baseUrl}/items`,
        side_effects: "read",
        max_retries: 0,
      },
      {
        id: "shape",
        kind: "transform",
        language: "javascript",
        expression:
          "const items = input.scope.read.data.items; return { names: items.map((i) => i.name), count: items.length, hidden: input.scope.read.data.note };",
      },
    ],
  };
}

function sensitiveDraft(slug: string): DraftDocument {
  const draft = withWorkflowDraft(
    createEmptyDraftDocument("workflow_authoring"),
    sensitiveWorkflow(slug),
  );
  return withWorkflowValidation(withWorkflowInspection(draft), true, "Workflow draft valid.");
}

function user(): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  };
}

function toolContext(initial: DraftDocument): ToolContext {
  let draft = initial;
  const principal = user();
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: CONVERSATION_ID,
    actor_id: principal.id,
    principal,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: principal.id,
      actor_type: principal.kind,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
}

const SUMMARY_KEYS = [
  "content_withheld",
  "counts",
  "duration_ms",
  "note",
  "output",
  "output_schema",
  "status",
  "steps",
  "validation",
];
const STEP_KEYS = new Set(["duration_ms", "failure", "held", "id", "kind", "pagination", "status"]);

test("a sensitive draft test run returns only allow-listed metadata", async () => {
  const context = toolContext(sensitiveDraft("sensitive-metadata-run"));
  const logs: unknown[] = [];
  const unsubscribe = logRing.subscribe((entry) => logs.push(entry));
  const result = await dryRunWorkflowTool
    .execute(context, { input: {}, include_step_results: true })
    .finally(unsubscribe);

  expect(result.ok).toBe(true);
  const data = result.data as Record<string, unknown>;
  const summary = data.sensitive_test_run as Record<string, unknown>;
  expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS);
  expect(summary).toMatchObject({
    status: "succeeded",
    content_withheld: true,
    validation: "passed",
    output_schema: "passed",
    output: { names: { type: "array", length: 3 }, count: { type: "number" } },
    counts: { total: 2, succeeded: 2, failed: 0, held: 0 },
  });
  const steps = summary.steps as Array<Record<string, unknown>>;
  expect(steps.map((step) => step.id)).toEqual(["read", "shape"]);
  for (const step of steps)
    for (const key of Object.keys(step)) expect(STEP_KEYS.has(key)).toBe(true);
  for (const forbidden of [
    "step_trace",
    "step_results",
    "final_output",
    "preview_evidence",
    "judge",
    "repair_proposals",
    "warnings",
  ])
    expect(data[forbidden]).toBeUndefined();

  expect(JSON.stringify(result)).not.toContain(PLANTED);
  expect(JSON.stringify(context.getDraft())).not.toContain(PLANTED);
  expect(JSON.stringify(logs)).not.toContain(PLANTED);
  expect(context.getDraft().latest_preview?.ok).toBe(true);
  expect(context.getDraft().state?.checkpoints.workflow_previewed?.ok).toBe(true);
  expect(getLastPreview({ tenant_id: ctx.tenant_id, conversation_id: CONVERSATION_ID })).toBeNull();
  expect(getMockProvider().calls).toHaveLength(0);

  const [row] = await ctx.testDb.db
    .select()
    .from(executions)
    .where(
      and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.id, String(data.execution_id))),
    );
  expect(isSensitivePayload(row?.input)).toBe(true);
  const allExecutions = await ctx.testDb.db
    .select()
    .from(executions)
    .where(eq(executions.tenant_id, ctx.tenant_id));
  const allSteps = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.tenant_id, ctx.tenant_id));
  const audit = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenant_id, ctx.tenant_id));
  expect(JSON.stringify(allExecutions)).not.toContain(PLANTED);
  expect(JSON.stringify(allSteps)).not.toContain(PLANTED);
  expect(JSON.stringify(audit)).not.toContain(PLANTED);
});

test("a sensitive draft test run holds writes and a second run does not replay a cache", async () => {
  const workflow = sensitiveWorkflow("sensitive-held-write");
  const draft = withWorkflowValidation(
    withWorkflowInspection(
      withWorkflowDraft(createEmptyDraftDocument("workflow_authoring"), {
        ...workflow,
        steps: [
          ...workflow.steps,
          {
            id: "send",
            kind: "request",
            method: "POST",
            url: `${mock.baseUrl}/send`,
            body: { note: "held" },
            max_retries: 0,
          },
        ],
      }),
    ),
    true,
    "Workflow draft valid.",
  );
  const before = mock.callCount();
  const first = await dryRunWorkflowTool.execute(toolContext(draft), { input: {} });
  const second = await dryRunWorkflowTool.execute(toolContext(draft), { input: {} });
  expect(writes).toBe(0);
  expect(mock.callCount() - before).toBe(2);
  for (const result of [first, second]) {
    const summary = (result.data as { sensitive_test_run: Record<string, unknown> })
      .sensitive_test_run;
    expect(summary.counts).toMatchObject({ total: 3, held: 1 });
    const send = (summary.steps as Array<Record<string, unknown>>).find((s) => s.id === "send");
    expect(send?.held).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PLANTED);
  }
});

test("the conversation stores only metadata for a sensitive test run", async () => {
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenant_id,
      status: "active",
      owner_id: ctx.user_id,
      draft: sensitiveDraft("sensitive-stored-run") as unknown as Record<string, unknown>,
    })
    .returning();
  if (!conversation) throw new Error("conversation insert failed");
  const logs: unknown[] = [];
  const unsubscribe = logRing.subscribe((entry) => logs.push(entry));
  const outcome = await invokeConversationToolDirect({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversation.id,
    actor_id: ctx.user_id,
    principal: user(),
    tool: "dry_run_workflow",
    args: { input: {}, include_step_results: true },
  }).finally(unsubscribe);
  expect(outcome.ok).toBe(true);

  const calls = await ctx.testDb.db
    .select()
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, ctx.tenant_id),
        eq(conversationToolCalls.conversation_id, conversation.id),
      ),
    );
  const dryRun = calls.find((call) => call.tool === "dry_run_workflow");
  expect(dryRun).toBeDefined();
  expect(JSON.stringify(dryRun?.output)).toContain("sensitive_test_run");
  const messages = await ctx.testDb.db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, ctx.tenant_id),
        eq(conversationMessages.conversation_id, conversation.id),
      ),
    );
  const [stored] = await ctx.testDb.db
    .select({ draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation.id)));
  expect(JSON.stringify(calls)).not.toContain(PLANTED);
  expect(JSON.stringify(messages)).not.toContain(PLANTED);
  expect(JSON.stringify(stored?.draft)).not.toContain(PLANTED);
  expect(JSON.stringify(outcome)).not.toContain(PLANTED);
  expect(JSON.stringify(getMockProvider().calls)).not.toContain(PLANTED);
  expect(JSON.stringify(logs)).not.toContain(PLANTED);
});
