// Integration regression test: chat elicit resume → run_workflow principal threading.
//
// The fix threaded resolveChatPrincipal() into respondElicitation() on the
// elicit-routing path. Before the fix, resuming an elicitation through the
// chat surface called respondElicitation without a principal, which caused
// run_workflow to refuse with error_code: "principal_required".
//
// This test verifies two invariants:
//   1. Resuming with a principal that has workflow:run rights → no principal_required
//      error in the tool results; run_workflow proceeds past the RBAC gate.
//   2. Resuming WITHOUT a principal (pre-fix simulation) → the run_workflow guard at
//      run-workflow.ts:334 DOES refuse with principal_required and the metric is bumped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
  respondElicitationForTest,
} from "../conversations/tests/setup.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { getMockProvider } from "../llm/mock-provider.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../observability/metrics.ts";

let ctx: ConversationTestCtx;
// The seeded workflow is BOUND to the conversation (target_workflow_id) so the
// run_workflow tool is legitimately exposed by the execution-tool gate — a
// conversation with a saved-workflow run target is exactly when execution tools
// are in scope. Without a bound (or named) workflow the gate default-denies
// run_workflow, which is the build-new-hijack guard, not this path.
let wfId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("elicit-routing-principal");

  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "elicit-test-wf",
      name: "Elicit Test Workflow",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");

  const [ver] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: "Elicit Test Workflow",
        slug: "elicit-test-wf",
        steps: [{ id: "noop", kind: "transform", expression: "$" }],
      },
    })
    .returning();
  if (!ver) throw new Error("seed workflow version failed");

  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: ver.id })
    .where(eq(workflows.id, wf.id));
  wfId = wf.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function counterSample(labels: Record<string, string>): number | undefined {
  const snap = getMetrics().snapshot();
  const series = snap.find((s) => s.name === METRIC_NAMES.AUTHORING_GATE_BLOCKS_TOTAL);
  if (!series) return undefined;
  const sample = series.samples.find((s) =>
    Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
  return sample?.value;
}

/** Drive a conversation to a pending ask_user_confirm and return the elicitation id. */
async function driveToElicitation(): Promise<{
  conversationId: string;
  elicitationId: string;
}> {
  const conversation = await createConversationWithTurn(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      connector_id: ctx.connector_id,
      workflow_id: wfId,
      initial_message: "get ready",
    },
    ctx.testDb.db,
  );
  const conversationId = conversation.conversation.id;

  getMockProvider().setConversePlan(conversationId, [
    // Force a real checkpoint under the autonomous default without changing
    // the resumed tool policy: this test must reach the principal guard.
    {
      tool: "ask_user_confirm",
      args: {
        question: "Confirm the destructive test checkpoint?",
        kind: "generic",
        destructive: true,
      },
    },
  ]);

  const second = await appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conversationId,
      actor_id: ctx.user_id,
      message: "yes run the workflow",
    },
    ctx.testDb.db,
  );
  expect(second.result.status).toBe("awaiting_input");
  const elicitationId = second.result.pending_elicitation_id;
  if (!elicitationId) throw new Error("no pending elicitation id");
  return { conversationId, elicitationId };
}

describe("chat elicit-routing principal threading", () => {
  test("resuming with a valid principal does NOT emit principal_required", async () => {
    resetMetricsRegistryForTests();

    const { conversationId, elicitationId } = await driveToElicitation();

    // Plan the resumed turn to call run_workflow.
    // run_workflow input schema takes `workflow` (slug or UUID), not `workflow_id`.
    getMockProvider().setConversePlan(conversationId, [
      { tool: "run_workflow", args: { workflow: "elicit-test-wf" } },
    ]);

    // Thread a principal with admin role — equivalent to what resolveChatPrincipal
    // returns for a fully-linked chat user with admin role.
    const principal: ResolvedPrincipal = {
      provider: "chat",
      kind: "user",
      id: ctx.user_id,
      tenant_id: ctx.tenant_id,
      roles: ["admin"],
    };

    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        elicitation_id: elicitationId,
        actor_id: ctx.user_id,
        principal,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );

    // run_workflow must NOT refuse with principal_required.
    const toolResults = resumed.result.events.filter((e) => e.type === "tool_result") as Array<{
      output?: { error_code?: string };
    }>;
    const principalRequiredResult = toolResults.find(
      (e) => e.output?.error_code === "principal_required",
    );
    expect(principalRequiredResult).toBeUndefined();

    // The metric counter for principal_required must remain absent.
    expect(counterSample({ code: "principal_required", tool: "run_workflow" })).toBeUndefined();
  });

  test("negative control: resuming WITHOUT principal causes run_workflow to refuse with principal_required", async () => {
    resetMetricsRegistryForTests();

    const { conversationId, elicitationId } = await driveToElicitation();

    getMockProvider().setConversePlan(conversationId, [
      { tool: "run_workflow", args: { workflow: "elicit-test-wf" } },
    ]);

    // Intentionally omit principal — simulates the pre-fix code path in
    // elicit-routing.ts where respondElicitation was called without a principal.
    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        elicitation_id: elicitationId,
        actor_id: ctx.user_id,
        // principal intentionally omitted — pre-fix behaviour
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );

    // run_workflow MUST have refused with principal_required.
    const toolResults = resumed.result.events.filter((e) => e.type === "tool_result") as Array<{
      output?: { error_code?: string };
    }>;
    const principalRequiredResult = toolResults.find(
      (e) => e.output?.error_code === "principal_required",
    );
    expect(principalRequiredResult).toBeDefined();

    // The metric counter MUST have been incremented.
    expect(
      counterSample({ code: "principal_required", tool: "run_workflow" }),
    ).toBeGreaterThanOrEqual(1);
  });
});
