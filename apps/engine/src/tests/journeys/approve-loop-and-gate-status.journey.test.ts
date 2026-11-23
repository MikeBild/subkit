import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/abort.ts";
import * as conversationsSvc from "../../conversations/service/index.ts";
import type { Db } from "../../db/client.ts";
import { type ConverseMockStep, getMockProvider } from "../../llm/mock-provider.ts";

async function createConversationAndRunTurn(
  params: conversationsSvc.CreateConversationParams,
  db: Db,
  plan?: ConverseMockStep[],
  principal?: ResolvedPrincipal,
): Promise<conversationsSvc.ConversationTurnOutcome> {
  const created = await conversationsSvc.createConversation(params, db);
  if (plan) getMockProvider().setConversePlan(created.conversation.id, plan);
  if (!created.initial_message) {
    return { conversation: created.conversation, result: { events: [], status: "active" } };
  }
  const ctrl = registerConversationAbort(created.conversation.tenant_id, created.conversation.id);
  try {
    return await conversationsSvc.runConversationTurn(
      {
        tenant_id: created.conversation.tenant_id,
        conversation_id: created.conversation.id,
        actor_id: params.actor_id ?? null,
        user_message: created.initial_message,
        answer_actor: TEST_HUMAN_ANSWER,
        user_memory: created.user_memory,
        turn_abort_ctrl: ctrl,
        ...(principal ? { principal } : {}),
      },
      db,
    );
  } finally {
    unregisterConversationAbort(created.conversation.tenant_id, created.conversation.id, ctrl);
  }
}

import { renderAuthoringContextBlock } from "../../conversations/loop/authoring-context-block.ts";
import { runWorkflowTool } from "../../conversations/tools/engine-api/writes/run-workflow.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import { conversationElicitations } from "../../db/schema/index.ts";
import { runExecution } from "../../execution/engine.ts";
import { writeSetupPreferences } from "../../identity/setup-preferences.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("80-approve-loop-and-gate-status");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("approve, loop and gate status", () => {
  test("AC1: duplicate /respond returns 409 elicitation_already_resolved with the previous decision", async () => {
    await writeSetupPreferences(
      ctx.db,
      { tenant_id: ctx.tenantId, user_id: ctx.userId },
      { ask_before_writing: true },
    );
    const outcome = await createConversationAndRunTurn(
      {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        initial_message: "list users from jsonplaceholder",
      },
      ctx.db,
      [
        {
          tool: "ask_user_confirm",
          args: { question: "Use the jsonplaceholder users endpoint?", kind: "generic" },
        },
      ],
      { provider: "test", kind: "user", id: ctx.userId, tenant_id: ctx.tenantId, roles: ["admin"] },
    );
    const conversationId = outcome.conversation.id;
    const [elicit] = await ctx.db
      .select({ id: conversationElicitations.id })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversationId))
      .limit(1);
    if (!elicit) throw new Error("expected an elicitation to be queued by the mock provider");

    const first = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${elicit.id}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(first.status).toBe(200);

    const second = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${elicit.id}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      code?: string;
      details?: { previous_status?: string };
    };
    expect(body.code).toBe("elicitation_already_resolved");
    expect(body.details?.previous_status).toBe("resolved");
  });

  test("AC2: run_workflow gate-error paths still emit a terminal status", async () => {
    const stubEngineClient = {
      context: { actor_id: ctx.userId, actor_type: "user" as const },
      workflows: { get: async () => null },
      audit_write: async () => {},
    };
    const draft: DraftDocument = {
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
    };
    const toolCtx: ToolContext = {
      db: ctx.db,
      tenant_id: ctx.tenantId,
      conversation_id: "00000000-0000-0000-0000-000000000000",
      actor_id: ctx.userId,
      connector_id: null,
      workflow_id: null,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching the runtime shape
      engineClient: stubEngineClient as any,
      getDraft: () => draft,
      setDraft: async () => {},
    };
    const result = await runWorkflowTool.execute(toolCtx, { environment: "dev" });
    expect(result.ok).toBe(false);
    expect((result.data as { status?: string }).status).toBe("failed");
    expect((result.data as { error_code?: string }).error_code).toBe("workflow_not_persisted");
  });

  test("AC3: for_each with empty results → loop_body_empty warning + partial_success at run_workflow", async () => {
    const seeded = await seedWorkflow(ctx, {
      slug: "empty-loop-journey",
      name: "Empty Loop Journey",
      steps: [
        {
          kind: "transform",
          id: "items",
          language: "javascript",
          expression: "return ['p1', 'p2', 'p3'];",
        },
        {
          kind: "transform",
          id: "fetch_resources",
          for_each: "(sourceData) => sourceData.items.data",
          language: "javascript",
          expression: "return [];",
        },
        {
          kind: "transform",
          id: "format_output",
          language: "javascript",
          expression: "return { count: 3 };",
        },
      ],
    });

    const exec = await runExecution({
      db: ctx.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: seeded.id },
      input: null,
    });
    expect(exec.status).toBe("succeeded");
    const empty = (exec.warnings ?? []).find((w) => w.code === "loop_body_empty");
    expect(empty).toBeDefined();
    expect(empty?.identifier).toBe("fetch_resources");
    const details = empty?.details as
      | { iterations: number; productive_iterations: number; scope_shape: string }
      | undefined;
    expect(details?.iterations).toBe(3);
    expect(details?.productive_iterations).toBe(0);
    expect(details?.scope_shape).toBe(
      "$scope.fetch_resources.data is an array of 3 iteration objects",
    );

    const stubEngineClient = {
      context: { actor_id: ctx.userId, actor_type: "user" as const },
      workflows: {
        get: async (id: string) => {
          const { getWorkflow } = await import("../../workflows/service.ts");
          return getWorkflow(ctx.tenantId, id, ctx.db);
        },
      },
      audit_write: async () => {},
    };
    const draft: DraftDocument = {
      workflow: { name: "Empty Loop Journey", slug: "empty-loop-journey", steps: [] },
      state: {
        mode: "execution",
        stage: "workflow_executed",
        connector_mutation_seq: 0,
        workflow_mutation_seq: 0,
        checkpoints: {},
        persisted_resources: [
          {
            kind: "workflow",
            id: seeded.id,
            slug: "empty-loop-journey",
            name: "Empty Loop Journey",
            version_id: seeded.version_id,
            version: 1,
            environment: null,
            saved_at: new Date(TEST_NOW_MS).toISOString(),
          },
        ],
        latest_execution: null,
        latest_diagnosis: null,
      },
      summary: {
        active_target: {
          kind: "workflow",
          id: seeded.id,
          slug: "empty-loop-journey",
          name: "Empty Loop Journey",
          environment: null,
          lifecycle_state: "persisted",
        },
        // biome-ignore lint/suspicious/noExplicitAny: minimal summary
      } as any,
    };
    const toolCtx: ToolContext = {
      db: ctx.db,
      tenant_id: ctx.tenantId,
      conversation_id: "00000000-0000-0000-0000-000000000000",
      actor_id: ctx.userId,
      principal: {
        provider: "test",
        kind: "user",
        id: ctx.userId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
      },
      connector_id: null,
      workflow_id: seeded.id,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      engineClient: stubEngineClient as any,
      getDraft: () => draft,
      setDraft: async () => {},
    };
    const out = await runWorkflowTool.execute(toolCtx, {
      workflow: seeded.id,
      environment: "dev",
    });
    expect((out.data as { status?: string }).status).toBe("partial_success");
    expect(out.ok).toBe(false);
  });

  test("AC5: scope manifest in authoring context exposes typed paths for plain steps and for_each steps", async () => {
    const out = renderAuthoringContextBlock({
      draft: {
        mode: "workflow_authoring",
        workflow: {
          name: "list-projects-resources",
          slug: "list-projects-resources",
          steps: [
            { id: "fetch_projects", kind: "request", method: "GET", url: "/v2/projects" },
            { id: "extract", kind: "transform", expression: "fetch_projects.data.projects" },
            {
              id: "get_project_resources",
              for_each: "(sourceData) => sourceData.extract.data",
              kind: "request",
              method: "GET",
              url: "/v2/projects/{id}/resources",
            },
          ],
        },
      } as unknown as Parameters<typeof renderAuthoringContextBlock>[0]["draft"],
      user_message: "list resources for every project",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("### Scope manifest");
    expect(out!).toContain("$scope.fetch_projects.data");
    expect(out!).toContain("$scope.get_project_resources.data");
    expect(out!).toContain("$item");
    expect(out!).toContain("flat access across all iterations");
    expect(out!).toContain("$scope.get_project_resources.data.get_project_resources.data");
    expect(out!).toContain("$scope.get_project_resources.data[0].get_project_resources.data");
  });

  test("AC6: dialog.turn_end log line carries per-turn token breakdown", async () => {
    const conversation = await createConversationAndRunTurn(
      {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        initial_message: "list users",
      },
      ctx.db,
    );
    const completed = (conversation.result.events ?? []).find(
      (ev) => (ev as { type?: string }).type === "completed",
    ) as
      | {
          type: "completed";
          status: string;
          usage?: {
            turn_tokens: number;
            turn_tokens_total?: number;
            prompt_tokens_last_call?: number;
            breakdown?: {
              system: number;
              skills: number;
              knowledge: number;
              docs: number;
              failures: number;
              messages: number;
              total: number;
            };
          };
        }
      | undefined;
    expect(completed).toBeDefined();
    const usage = completed?.usage;
    expect(typeof usage?.turn_tokens).toBe("number");
    expect(typeof usage?.turn_tokens_total).toBe("number");
    expect(typeof usage?.prompt_tokens_last_call).toBe("number");
    expect(usage?.breakdown).toBeDefined();
    const b = usage?.breakdown;
    expect(b).toBeDefined();
    if (!b) throw new Error("breakdown missing");
    expect(typeof b.system).toBe("number");
    expect(typeof b.skills).toBe("number");
    expect(typeof b.knowledge).toBe("number");
    expect(typeof b.docs).toBe("number");
    expect(typeof b.failures).toBe("number");
    expect(typeof b.messages).toBe("number");
    expect(typeof b.total).toBe("number");
  });
});
