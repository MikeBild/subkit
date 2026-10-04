// User story: A user opens sk, asks to "fetch all resources across all
// DigitalOcean projects", iterates a workflow draft a few times, types
// `approve` twice, and never sees the final result. The originating
// session is `79bf2cca`. This journey locks in fixes for the six
// failure modes seen in that transcript so they cannot regress
// silently.
//
// WHY THE EXISTING TEST SUITE DID NOT CATCH THESE:
//
//   - The unit-tests for `respondElicitation` only exercised the happy
//     path (single response on a pending row). They didn't model the
//     race where a user double-presses `approve` while the engine is
//     still processing — so the duplicate-response → re-run-loop bug
//     went unobserved.
//   - The `run_workflow` tool tests only asserted `result.ok`; they
//     never asserted that every return path carries a terminal
//     `status` field. The CLI's "Execution status missing from
//     engine — bug, not a state" check (authoring-cards.tsx) had no
//     paired engine-side guarantee.
//   - The execution-engine loop tests covered loops with productive
//     bodies. The pathological case — N iterations, every body
//     "succeeded" but each produced an empty array — was not in the
//     fixture set, so the false-positive `succeeded` workflow status
//     went undetected.
//   - (Retired) The transform-warning case that checked the
//     `unresolved_identifier` runtime warning was a JSONata-runtime
//     diagnostic. Transforms are JavaScript-only now and the JS
//     transform runtime no longer emits that warning class, so the
//     case was removed (see the AC4 note below).
//   - Authoring-context-block tests asserted the human-readable lines
//     for steps and previews but not the typed scope manifest — the
//     thing that would prevent the agent from inventing
//     `$scope.<step>.data.resources` style paths.
//   - The token-budget tests measured cap behavior in isolation; they
//     never asserted that an operator reading engine logs alone can
//     see the per-turn token breakdown.
//
// AC1. Duplicate `/respond` returns HTTP 409 `elicitation_already_resolved`
//      with the previous decision; engine does not re-run the
//      conversation loop.
// AC2. `run_workflow` always emits a terminal `status` field — succeeded,
//      failed, or partial_success — even on the gate-error paths
//      (workflow_not_persisted, repair_loop_detected, run_failed).
// AC3. A loop with N iterations whose body produces empty results is
//      classified `partial_success`, surfaces a `loop_body_empty`
//      warning with the actual envelope shape, and the run_workflow
//      tool result reflects the downgrade — not "succeeded".
// AC4. (Removed) Previously asserted an `unresolved_identifier` warning
//      with `details.available_paths` + `details.suggestion`. That was a
//      JSONata-runtime diagnostic; transforms are JavaScript-only now and
//      the JS transform runtime does not emit it. The surviving bare-path
//      typo/suggestion contract lives in the authoring-time reference
//      validator (reference-validator-fp.test.ts).
// AC5. The dialog.turn_end log line on the engine side includes the
//      per-turn token breakdown (system, skills, knowledge, docs,
//      messages, total). Operators reading engine logs alone can
//      attribute cost to turns.
//
// These ACs are the post-fix invariants that, together, make the
// session-79bf2cca transcript impossible to reproduce silently.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/abort.ts";
import * as conversationsSvc from "../../conversations/service.ts";
import type { Db } from "../../db/client.ts";

// Create a conversation, persist the first message, run the turn — the
// pre-async-Tasks `createConversation` ergonomics. Production splits
// row-insert from the model loop; this helper recomposes them for the
// journey assertions.
async function createConversationAndRunTurn(
  params: conversationsSvc.CreateConversationParams,
  db: Db,
): Promise<conversationsSvc.ConversationTurnOutcome> {
  const created = await conversationsSvc.createConversation(params, db);
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
      },
      db,
    );
  } finally {
    unregisterConversationAbort(created.conversation.tenant_id, created.conversation.id, ctrl);
  }
}

import { runWorkflowTool } from "../../conversations/tools/engine-api/writes/run-workflow.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import { conversationElicitations } from "../../db/schema/index.ts";
import { runExecution } from "../../execution/engine.ts";
import { renderAuthoringContextBlock } from "../../llm/core/authoring-context-block.ts";
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
  ctx = await createJourneyCtx("53-session-79bf2cca-regression");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 53: session-79bf2cca regression set", () => {
  test("AC1: duplicate /respond returns 409 elicitation_already_resolved with the previous decision", async () => {
    const outcome = await createConversationAndRunTurn(
      {
        permission_mode: "ask",
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        initial_message: "list users from jsonplaceholder",
      },
      ctx.db,
    );
    const conversationId = outcome.conversation.id;
    const [elicit] = await ctx.db
      .select({ id: conversationElicitations.id })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversationId))
      .limit(1);
    if (!elicit) throw new Error("expected an elicitation to be queued by the mock provider");

    // First response — should succeed.
    const first = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${elicit.id}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(first.status).toBe(200);

    // Second response on the same elicitation must NOT re-run the loop.
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
    // Build a tool context with no persisted workflow so the tool hits
    // the `workflow_not_persisted` gate-error path.
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
      permission_mode: "auto",
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching the runtime shape
      engineClient: stubEngineClient as any,
      getDraft: () => draft,
      setDraft: async () => {},
    };
    const result = await runWorkflowTool.execute(toolCtx, { environment: "dev" });
    expect(result.ok).toBe(false);
    // The CLI's authoring-cards.tsx emits "Execution status missing —
    // bug, not a state" when this field is missing. Lock it in here.
    expect((result.data as { status?: string }).status).toBe("failed");
    expect((result.data as { error_code?: string }).error_code).toBe("workflow_not_persisted");
  });

  test("AC3: loop with empty body → loop_body_empty warning + partial_success at run_workflow", async () => {
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
          kind: "loop",
          id: "iter",
          over: "items.data",
          body: ["fetch_resources"],
        },
        // Body always returns []. Three iterations succeed; productive body output = 0.
        {
          kind: "transform",
          id: "fetch_resources",
          language: "javascript",
          expression: "return [];",
        },
        // Top-level output is non-empty so the *legacy* heuristic ("output is []")
        // would have missed this; only the new `loop_body_empty` warning catches it.
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
    expect(empty?.identifier).toBe("iter");
    const details = empty?.details as
      | { iterations: number; productive_iterations: number; example_path: string }
      | undefined;
    expect(details?.iterations).toBe(3);
    expect(details?.productive_iterations).toBe(0);
    expect(details?.example_path).toBe("$scope.iter.data[0].fetch_resources.data");

    // run_workflow tool must reflect the partial_success even when the
    // top-level output is non-empty.
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
      // run_workflow now refuses without a principal; seed an admin-shaped
      // one so the RBAC gate passes and the test exercises the loop-body-
      // empty warning path it was written to catch.
      principal: {
        provider: "test",
        kind: "user",
        id: ctx.userId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
      },
      connector_id: null,
      workflow_id: seeded.id,
      permission_mode: "auto",
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

  // AC4 (removed): the old `unresolved_identifier` warning with
  // `available_paths` + `suggestion` was a JSONata-runtime diagnostic.
  // Transforms are now JavaScript-only — the JS transform runtime
  // (execution/steps/transform.ts) does not emit that warning class, so
  // the case it asserted no longer has a code path to exercise. The
  // bare-path typo / suggestion contract that survives lives in the
  // authoring-time reference validator (reference-validator.ts), covered
  // by reference-validator-fp.test.ts.

  test("AC5: scope manifest in authoring context exposes typed paths for plain steps and loop body", async () => {
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
              id: "fetch_resources",
              kind: "loop",
              over: "extract.data",
              body: ["get_project_resources"],
            },
            {
              id: "get_project_resources",
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
    // Loop-specific shape — the LLM needs to see this exact form so it
    // does not invent `$scope.fetch_resources.data.resources`.
    expect(out!).toContain("$scope.fetch_resources.data");
    expect(out!).toContain("$item");
    expect(out!).toContain("flat access across all iterations");
    expect(out!).toContain("$scope.fetch_resources.data.get_project_resources.data");
    expect(out!).toContain("$scope.fetch_resources.data[0].get_project_resources.data");
  });

  test("AC6: dialog.turn_end log line carries per-turn token breakdown", async () => {
    // The breakdown object lives on the `completed` event sent to the
    // CLI (turn-event payload) AND is mirrored to the engine logger.
    // Asserting on the event shape is the cheap, deterministic way to
    // pin the contract — the logger call is a sibling of the same
    // `breakdown` literal.
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
            remaining_monthly_budget_tokens: number | null;
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
    // Honest cost split (Fix 7): cumulative turn total is always
    // emitted; the last-call prompt size rides along when the turn made
    // at least one LLM call (this one did — it produced a reply).
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
