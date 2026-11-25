import { describe, expect, test } from "bun:test";
import type { LlmCallLogEntry } from "../llm/types.ts";
import { type SuggestNextModelInvoker, suggestNextMessage } from "./suggest-next.ts";

const noOfferHistory = [
  { role: "user" as const, text: "fix the bug" },
  { role: "assistant" as const, text: "Bug fixed. Tests are green." },
];

const runWith = async (invoker: SuggestNextModelInvoker) => {
  const recordedEntries: LlmCallLogEntry[] = [];
  const result = await suggestNextMessage({
    tenant_id: "tenant-usage",
    conversation_id: "conversation-usage",
    recent_messages: noOfferHistory,
    last_assistant_text: "Bug fixed. Tests are green.",
    model_invoker: invoker,
    usage_recorder: async (entry) => {
      recordedEntries.push(entry);
    },
  });
  return { result, recordedEntries };
};

describe("suggestNextMessage — llm usage accounting", () => {
  test("records one suggest_next usage row with the conversation id", async () => {
    const seenConversations: string[] = [];
    const { recordedEntries } = await runWith(async (call) => {
      seenConversations.push(call.conversation_id);
      return {
        text: "commit this",
        model: "anthropic/claude-haiku-4-5",
        latency_ms: 42,
        usage: {
          input_tokens: 80,
          output_tokens: 4,
          cache_read_tokens: 3,
          cache_creation_tokens: 1,
        },
      };
    });
    expect(seenConversations).toEqual(["conversation-usage"]);
    expect(recordedEntries).toEqual([
      {
        tenant_id: "tenant-usage",
        flow: "suggest_next",
        model: "anthropic/claude-haiku-4-5",
        prompt_tokens: 80,
        completion_tokens: 4,
        cache_read_tokens: 3,
        cache_creation_tokens: 1,
        latency_ms: 42,
        result: "success",
        conversation_id: "conversation-usage",
        actor_type: "system",
      },
    ]);
  });

  test("records the call even when the provider reports zero tokens", async () => {
    const { recordedEntries } = await runWith(async () => ({
      text: "",
      model: "openai/gpt-5-mini",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    }));
    expect(recordedEntries).toHaveLength(1);
    expect(recordedEntries[0]).toMatchObject({
      flow: "suggest_next",
      model: "openai/gpt-5-mini",
      prompt_tokens: 0,
      completion_tokens: 0,
      latency_ms: 0,
      conversation_id: "conversation-usage",
    });
  });

  test("carries reported cache figures so the call counts toward the cache share", async () => {
    const { recordedEntries } = await runWith(async () => ({
      text: "commit this",
      model: "anthropic/claude-haiku-4-5",
      usage: {
        input_tokens: 80,
        output_tokens: 4,
        cache_read_tokens: 60,
        cache_creation_tokens: 0,
        cache_reported: true,
      },
    }));
    expect(recordedEntries[0]).toMatchObject({ cache_read_tokens: 60, cache_reported: true });
  });

  test("keeps an explicit zero cache read distinct from a missing figure", async () => {
    const reported = await runWith(async () => ({
      text: "commit this",
      model: "openai/gpt-5-mini",
      usage: {
        input_tokens: 80,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_reported: true,
      },
    }));
    const omitted = await runWith(async () => ({
      text: "commit this",
      model: "openai/gpt-5-mini",
      usage: {
        input_tokens: 80,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_reported: false,
      },
    }));
    expect(reported.recordedEntries[0]?.cache_reported).toBe(true);
    expect(omitted.recordedEntries[0]?.cache_reported).toBe(false);
  });

  test("records nothing when no model answered", async () => {
    const { result, recordedEntries } = await runWith(async () => ({ text: null }));
    expect(result.reason).toBe("empty");
    expect(recordedEntries).toEqual([]);
  });

  test("a failing usage recorder never fails the suggestion", async () => {
    const result = await suggestNextMessage({
      tenant_id: "tenant-usage",
      conversation_id: "conversation-usage",
      recent_messages: noOfferHistory,
      last_assistant_text: "Bug fixed. Tests are green.",
      model_invoker: async () => ({ text: "commit this", model: "anthropic/claude-haiku-4-5" }),
      usage_recorder: async () => {
        throw new Error("db down");
      },
    });
    expect(result).toEqual({ suggestion: "commit this", reason: "model", kind: "text" });
  });
});
