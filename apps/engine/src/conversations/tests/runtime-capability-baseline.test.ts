import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listCapabilityGaps } from "../../discovery/service.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { loadTenantSummary, renderTenantSummaryBlock } from "../../llm/runtime/tenant-summary.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
} from "./setup.ts";

const skip = testEnv.REQUIRES_PG === "0";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  if (skip) return;
  ctx = await createConversationTestCtx("cap_baseline");
});

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
});

describe.skipIf(skip)("runtime-capability grounding — baseline", () => {
  test("the prompt-time snapshot grounds connector IDENTITY but not capability or access", async () => {
    const block = renderTenantSummaryBlock(
      await loadTenantSummary(
        {
          provider: "test",
          kind: "user",
          id: ctx.user_id,
          tenant_id: ctx.tenant_id,
          roles: ["admin"],
        },
        ctx.testDb.db,
      ),
      new Set(),
    );
    expect(block).not.toBeNull();
    const text = block!;
    expect(text).toContain("cap_baseline");
    expect(text.toLowerCase()).not.toContain("access:");
    expect(text.toLowerCase()).not.toContain("ops:");
    expect(text).not.toMatch(/\b(GET|POST|PUT|DELETE)\s+\//);
  });

  test("a cannot_help for a missing capability records a durable capability gap (honest abstention)", async () => {
    const before = await listCapabilityGaps({ tenant_id: ctx.tenant_id }, ctx.testDb.db);
    const conv = await createConversationWithTurn(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
      ctx.testDb.db,
    );
    getMockProvider().setConversePlan(conv.conversation.id, [
      {
        tool: "cannot_help",
        args: {
          reason: "There is no Stripe connector in this tenant, and I will not invent one.",
          missing_capability: "connector.stripe",
          suggest_alternative: "Set up a Stripe connector, then I can build the payment workflow.",
        },
      },
    ]);
    const outcome = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conv.conversation.id,
        actor_id: ctx.user_id,
        message: "Take a Stripe payment from a customer",
      },
      ctx.testDb.db,
    );
    expect(["active", "completed", "awaiting_input"]).toContain(outcome.result.status);
    const after = await listCapabilityGaps({ tenant_id: ctx.tenant_id }, ctx.testDb.db);
    expect(after.length).toBeGreaterThan(before.length);
    expect(
      after.some(
        (g) =>
          (g.draft as { missing_capability?: string }).missing_capability === "connector.stripe",
      ),
    ).toBe(true);
  });
});
