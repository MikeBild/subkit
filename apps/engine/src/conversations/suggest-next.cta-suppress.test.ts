// Unit tests for the endsWithCtaQuestion suppression path introduced
// in 6.2.12 (Fix #5).
//
// Context: `suggestNextMessage` runs offer-parse FIRST. If the offer
// parser matches ("Want me to X?", "Shall I Y?" etc.) it returns the
// offer suggestion before the CTA-question suppressor runs. The
// suppressor fires only when:
//   1. offer-parse missed (no recognised offer pattern), AND
//   2. the assistant's last text ends with a question sentence
//      (trimmed ends with "?", last sentence ≤280 chars).
//
// Tests pass `recent_messages` with ≥2 entries so the early-conversation
// gate doesn't short-circuit, and omit `model_invoker` so the model
// fallback returns "empty" — the CTA suppressor fires BEFORE that path.

import { describe, expect, test } from "bun:test";
import { suggestNextMessage } from "./suggest-next.ts";

const TWO_MSG_HISTORY = [
  { role: "user" as const, text: "Can you review the OCPP spec?" },
  { role: "assistant" as const, text: "Sure, let me scan it for you." },
];

describe("suggestNextMessage — CTA-question suppression", () => {
  test('returns {suggestion:null, reason:"filtered"} when last_assistant_text ends with a CTA question (offer-parse misses)', async () => {
    // "Which section would you like to explore further?" has no offer
    // verb ("want me to", "shall I", etc.) so offer-parse passes
    // through, and the CTA suppressor fires.
    const result = await suggestNextMessage({
      tenant_id: "t1",
      conversation_id: "c1",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text:
        "I've reviewed the OCPP 2.0.1 specification. Which section would you like to explore further?",
    });
    expect(result.suggestion).toBeNull();
    expect(result.reason).toBe("filtered");
  });

  test("offer-parse wins over CTA suppression when text ends with 'Want to do that next?' (offer verb present)", async () => {
    // "Want to do that next?" matches the offer-parse `want to\s+...`
    // pattern, so the offer-parse fast path fires BEFORE the CTA
    // suppressor. The result should be an offer suggestion, NOT
    // suppression.
    const result = await suggestNextMessage({
      tenant_id: "t2",
      conversation_id: "c2",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text: "I have drafted the workflow with 3 steps. Want to do that next?",
    });
    // Offer-parse matched — result must carry a suggestion, NOT "filtered".
    expect(result.reason).toBe("offer-detected");
    expect(result.suggestion).not.toBeNull();
  });

  test("does NOT suppress when final sentence is declarative (question is embedded mid-text)", async () => {
    // The heuristic uses the last sentence boundary, so a question
    // buried mid-paragraph with a declarative final sentence should
    // NOT trigger the suppressor.
    const result = await suggestNextMessage({
      tenant_id: "t3",
      conversation_id: "c3",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text:
        "You asked which sections to review. I've highlighted the three most relevant: §4.2, §6.1, and §8.3. These cover the charge-point boot sequence in detail.",
    });
    // Final sentence is declarative — CTA suppressor must NOT fire.
    // With no model_invoker, result is "empty" (model fallback path).
    expect(result.reason).toBe("empty");
    expect(result.suggestion).toBeNull();
  });

  test("does NOT suppress when last_assistant_text is empty (early-conversation or empty guard handles it)", async () => {
    // Empty text: endsWithCtaQuestion returns false (nothing ends with
    // "?"), so the suppressor does not fire. With ≥2 messages in history,
    // we reach the model fallback which returns "empty" (no invoker).
    const result = await suggestNextMessage({
      tenant_id: "t4",
      conversation_id: "c4",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text: "",
    });
    // NOT "filtered" — the suppressor didn't fire.
    expect(result.reason).toBe("empty");
    expect(result.suggestion).toBeNull();
  });

  test("does NOT suppress on a trailing '?' embedded in code/data (last sentence is within a fenced context)", async () => {
    // The last sentence boundary heuristic looks for ". ", "\n", or
    // "? " prior to the final "?". A string whose last meaningful text
    // is a declarative statement, with the "?" only part of an embedded
    // token, should not trigger the CTA suppressor.
    // Here the trailing `?` is on the last line of a code block and
    // the text after the code block is a declarative statement.
    const result = await suggestNextMessage({
      tenant_id: "t5",
      conversation_id: "c5",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text:
        'Here is the transformed payload:\n\n```json\n{ "active": "X?" }\n```\n\nThe transform step is configured correctly.',
    });
    // Final real sentence ends with "." — the heuristic should NOT
    // fire the CTA suppressor. Result is "empty" (no model invoker).
    expect(result.reason).toBe("empty");
    expect(result.suggestion).toBeNull();
  });

  test("does NOT fire when history has fewer than 2 messages (early-conversation gate first)", async () => {
    // The early-conversation guard (< 2 messages) fires before the CTA
    // suppressor, so even a CTA-shaped text doesn't reach that path.
    const result = await suggestNextMessage({
      tenant_id: "t6",
      conversation_id: "c6",
      recent_messages: [{ role: "user", text: "hello" }],
      last_assistant_text: "Which section would you like to explore further?",
    });
    expect(result.reason).toBe("early-conversation");
    expect(result.suggestion).toBeNull();
  });
});
