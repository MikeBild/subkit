import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { automationReviewStopCondition } from "../../conversations/loop/stop-conditions.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { reviewWorkflowAutomationTool } from "../../conversations/tools/review-workflow-automation.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import { users } from "../../db/schema/index.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const SECRET = "whsec_j60_standardaaaaaaaaaaaaaaa";
const HOOK = "findings-review";

function sign(id: string, ts: number, body: string): string {
  return `v1,${createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

let ctx: JourneyCtx;
let hookWorkflowId = "";
let idleWorkflowId = "";
let memberId = "";

const principal = (role: "admin" | "member"): ResolvedPrincipal => ({
  provider: "api_key",
  kind: "user",
  id: role === "admin" ? ctx.userId : memberId,
  tenant_id: ctx.tenantId,
  roles: [role],
});

async function review(workflow_id: string, role: "admin" | "member" = "admin") {
  let draft: DraftDocument = { workflow: { name: "", steps: [] } };
  const toolCtx = {
    db: ctx.db,
    tenant_id: ctx.tenantId,
    conversation_id: "00000000-0000-4000-8000-000000000060",
    actor_id: principal(role).id,
    principal: principal(role),
    connector_id: null,
    workflow_id,
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  } as unknown as ToolContext;
  const output = await reviewWorkflowAutomationTool.execute(toolCtx, { workflow_id });
  const ends = automationReviewStopCondition({
    steps: [{ toolResults: [{ toolName: "review_workflow_automation", output }] }],
  });
  return { output: output as { ok: boolean; data: Record<string, unknown> }, ends };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("hook-review");
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-hook-review@test.local",
      role_id: ctx.rbacRoleIds.member,
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  memberId = member.id;
  const steps = [{ id: "noop", kind: "transform", expression: "$" }];
  hookWorkflowId = (await seedWorkflow(ctx, { slug: "hook-only", name: "Hook only", steps })).id;
  idleWorkflowId = (await seedWorkflow(ctx, { slug: "idle", name: "Idle", steps })).id;
  const binding = await journeyFetch(ctx, "/v1/webhooks/inbound", {
    method: "POST",
    body: JSON.stringify({
      slug: HOOK,
      workflow_id: hookWorkflowId,
      verifier: "standard",
      secret: SECRET,
    }),
  });
  expect(binding.status).toBe(201);
  const body = JSON.stringify({ finding: 1 });
  const webhookId = "refused-review-delivery";
  // allow-wall-clock: the HTTP ingress verifies the live signature window.
  const ts = Math.floor(Date.now() / 1000);
  const refused = await fetch(`${ctx.baseUrl}/v1/hooks/${HOOK}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(ts),
      "webhook-signature": sign(webhookId, ts, body),
    },
  });
  expect(refused.status).toBe(409);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: the side chat answers about a webhook-started workflow", () => {
  test("AC1: the review carries the hook and ends on a card that shows it", async () => {
    const { output, ends } = await review(hookWorkflowId);
    expect(output.ok).toBe(true);
    const hooks = output.data.inbound_hooks as Array<Record<string, unknown>>;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      workflow_id: hookWorkflowId,
      slug: HOOK,
      environment: "prod",
      admission_hold: { reason_code: expect.stringMatching(/^execution_authority_/) },
      last_refused_reason: expect.stringMatching(/^execution_authority_/),
      review: expect.objectContaining({ eligible_for_repeated_runs: expect.any(Boolean) }),
    });
    expect(output.data.presentation).toBe("automation_readiness_card");
    expect(ends).toBe(true);
  });

  test("AC2: without audit:read the hook is shown, its refusal reason is not", async () => {
    const { output } = await review(hookWorkflowId, "member");
    const hooks = output.data.inbound_hooks as Array<Record<string, unknown>>;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.last_refused_reason).toBeNull();
  });

  test("AC3: nothing to show means no card and no silent stop", async () => {
    const { output, ends } = await review(idleWorkflowId);
    expect(output.ok).toBe(true);
    expect(output.data.presentation).toBe("text");
    expect(ends).toBe(false);
  });
});
