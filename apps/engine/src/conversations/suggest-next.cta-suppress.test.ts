import { describe, expect, test } from "bun:test";
import { suggestNextMessage } from "./suggest-next.ts";

const TWO_MSG_HISTORY = [
  { role: "user" as const, text: "Can you review the OCPP spec?" },
  { role: "assistant" as const, text: "Sure, let me scan it for you." },
];

describe("suggestNextMessage — CTA-question suppression", () => {
  test('returns {suggestion:null, reason:"filtered"} when last_assistant_text ends with a CTA question (offer-parse misses)', async () => {
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
    const result = await suggestNextMessage({
      tenant_id: "t2",
      conversation_id: "c2",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text: "I have drafted the workflow with 3 steps. Want to do that next?",
    });
    expect(result.reason).toBe("offer-detected");
    expect(result.suggestion).not.toBeNull();
  });

  test("does NOT suppress when final sentence is declarative (question is embedded mid-text)", async () => {
    const result = await suggestNextMessage({
      tenant_id: "t3",
      conversation_id: "c3",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text:
        "You asked which sections to review. I've highlighted the three most relevant: §4.2, §6.1, and §8.3. These cover the charge-point boot sequence in detail.",
    });
    expect(result.reason).toBe("empty");
    expect(result.suggestion).toBeNull();
  });

  test("does NOT suppress when last_assistant_text is empty (early-conversation or empty guard handles it)", async () => {
    const result = await suggestNextMessage({
      tenant_id: "t4",
      conversation_id: "c4",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text: "",
    });
    expect(result.reason).toBe("empty");
    expect(result.suggestion).toBeNull();
  });

  test("does NOT suppress on a trailing '?' embedded in code/data (last sentence is within a fenced context)", async () => {
    const result = await suggestNextMessage({
      tenant_id: "t5",
      conversation_id: "c5",
      recent_messages: TWO_MSG_HISTORY,
      last_assistant_text:
        'Here is the transformed payload:\n\n```json\n{ "active": "X?" }\n```\n\nThe transform step is configured correctly.',
    });
    expect(result.reason).toBe("empty");
    expect(result.suggestion).toBeNull();
  });

  test("does NOT fire when history has fewer than 2 messages (early-conversation gate first)", async () => {
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
