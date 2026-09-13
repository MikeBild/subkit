// Phase 3 — deterministic capability-gap next-suggestion.
//
// When a turn abstains via cannot_help, the emitter must surface the
// gap-closing path as the next prompt WITHOUT a model call, ahead of the
// model fallback. Pure unit test — no DB, no model.

import { describe, expect, test } from "bun:test";

import type { TurnEvent } from "../types.ts";
import { buildNextSuggestionFrame } from "./suggest-next-emitter.ts";

function cannotHelpEvents(data: Record<string, unknown>): TurnEvent[] {
  return [
    {
      type: "tool_result",
      call_id: "c1",
      tool: "cannot_help",
      output: { ok: true, data },
    } as TurnEvent,
  ];
}

describe("capability-gap next-suggestion", () => {
  test("prefers the model's suggest_alternative as the next prompt", async () => {
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: cannotHelpEvents({
        abstained: true,
        missing_capability: "connector.stripe",
        suggest_alternative: "Set up a Stripe connector, then I can build the payment workflow.",
      }),
    });
    expect(frame).toMatchObject({
      type: "next_suggestion",
      reason: "capability-gap",
      kind: "text",
      suggestion: "Set up a Stripe connector, then I can build the payment workflow.",
    });
  });

  test("derives a prompt from the missing_capability slug when no alternative given", async () => {
    const frame = await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: cannotHelpEvents({ abstained: true, missing_capability: "connector.stripe.refunds" }),
    });
    expect(frame).toMatchObject({
      type: "next_suggestion",
      reason: "capability-gap",
      suggestion: "Set up a connector for stripe refunds",
    });
  });

  test("respects client suppression (falls through to the normal path)", async () => {
    const frame = (await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      client_suppress: true,
      events: cannotHelpEvents({ abstained: true, missing_capability: "connector.stripe" }),
    })) as Extract<TurnEvent, { type: "next_suggestion" }>;
    expect(frame.reason).not.toBe("capability-gap");
  });

  test("no cannot_help → not a capability-gap suggestion", async () => {
    const frame = (await buildNextSuggestionFrame({
      tenant_id: "t",
      conversation_id: "c",
      events: [{ type: "text_delta", text: "hi" } as TurnEvent],
    })) as Extract<TurnEvent, { type: "next_suggestion" }>;
    expect(frame.reason).not.toBe("capability-gap");
  });
});
