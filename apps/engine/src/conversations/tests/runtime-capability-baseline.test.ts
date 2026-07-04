// Runtime-capability grounding — BASELINE evidence (today's behaviour).
//
// Captures the two gaps the research identified, as runnable assertions, so a
// future Phase-1/2/3 change is gated against a real before-picture:
//   1. The tenant snapshot is IDENTITY-ONLY at prompt time — it names which
//      connectors/workflows exist but NOT what they can do (operations) or
//      whether the caller is allowed to use them (access level). That is why
//      the engine cannot honestly answer "can connector X do Y?" or "am I
//      allowed to do Z?" before a tool round-trip.
//   2. The honest-abstention path DOES work: a cannot_help with a missing
//      capability records a durable, deduped capability_gap (the A3 loop) —
//      the foundation a Phase-3 prompt-suggestion will build on.
//
// When Phase 1 lands (capability + access tags in the snapshot), assertion (1)
// flips — that is the measured gate. This is a plain DB test (no model).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listCapabilityGaps } from "../../discovery/service.ts";
import { loadTenantSummary, renderTenantSummaryBlock } from "../../llm/core/tenant-summary.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
} from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";

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
    const block = renderTenantSummaryBlock(await loadTenantSummary(ctx.tenant_id, ctx.testDb.db));
    expect(block).not.toBeNull();
    const text = block!;
    // Identity IS grounded — the seeded connector's slug appears.
    expect(text).toContain("cap_baseline");
    // Capability + permission are NOT present today (the gap Phase 1 closes):
    // no per-connector operation signatures, no enforced access level.
    expect(text.toLowerCase()).not.toContain("access:");
    expect(text.toLowerCase()).not.toContain("ops:");
    expect(text).not.toMatch(/\b(GET|POST|PUT|DELETE)\s+\//); // no operation signatures
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
    // The turn ends cleanly (cannot_help stops the loop) and does not error.
    expect(["active", "completed", "awaiting_input"]).toContain(outcome.result.status);
    // The gap is now a durable, deduped capability_gap (the A3 loop).
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
