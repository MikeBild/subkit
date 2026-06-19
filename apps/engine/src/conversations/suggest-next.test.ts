import { describe, expect, test } from "bun:test";
import { type SuggestNextModelInvoker, suggestNextMessage } from "./suggest-next.ts";

const baseHistory = [
  { role: "user" as const, text: "should I commit?" },
  { role: "assistant" as const, text: "All set. Want me to commit and push it?" },
];

describe("suggestNextMessage — guards", () => {
  test("client_suppress short-circuits with 'client-suppress'", async () => {
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: baseHistory,
      last_assistant_text: "Want me to commit and push it?",
      client_suppress: true,
    });
    expect(result).toEqual({ suggestion: null, reason: "client-suppress", kind: null });
  });

  test("history < 2 returns 'early-conversation'", async () => {
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: [{ role: "user", text: "hi" }],
      last_assistant_text: "Want me to commit?",
    });
    expect(result.reason).toBe("early-conversation");
    expect(result.suggestion).toBeNull();
  });
});

describe("suggestNextMessage — offer-parse fast path", () => {
  test("returns offer-detected suggestion verbatim, never calls the model", async () => {
    let modelCalls = 0;
    const invoker: SuggestNextModelInvoker = async () => {
      modelCalls += 1;
      return { text: "should never run" };
    };
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: baseHistory,
      last_assistant_text: "Want me to commit and push it?",
      model_invoker: invoker,
    });
    expect(result).toEqual({
      suggestion: "commit and push it",
      reason: "offer-detected",
      kind: "text",
    });
    expect(modelCalls).toBe(0);
  });

  test("returns offer-skill slash invocation when a loaded skill verb matches", async () => {
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: baseHistory,
      last_assistant_text: "Want me to draft the release notes?",
      loaded_skills: [{ slug: "release-notes", verbs: ["draft"] }],
    });
    expect(result).toEqual({
      suggestion: "/skill release-notes draft",
      reason: "offer-skill",
      kind: "slash",
    });
  });

  test("offer-parse output that fails the filter collapses to 'filtered'", async () => {
    // Pattern matches "Want me to ...?" but the captured action triggers
    // the claude-voice filter rule.
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: baseHistory,
      last_assistant_text: "Want me to let me handle the rest?",
    });
    expect(result.reason).toBe("filtered");
    expect(result.suggestion).toBeNull();
  });
});

describe("suggestNextMessage — model fallback", () => {
  const noOfferHistory = [
    { role: "user" as const, text: "fix the bug and run tests" },
    { role: "assistant" as const, text: "Bug fixed. Tests are green." },
  ];

  test("model output passes through when valid", async () => {
    const invoker: SuggestNextModelInvoker = async () => ({
      text: "commit this",
      usage: {
        input_tokens: 80,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: "anthropic/claude-haiku-4-5",
    });
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: noOfferHistory,
      last_assistant_text: "Bug fixed. Tests are green.",
      model_invoker: invoker,
    });
    expect(result).toEqual({ suggestion: "commit this", reason: "model", kind: "text" });
  });

  test("model output starting with / is tagged as slash", async () => {
    const invoker: SuggestNextModelInvoker = async () => ({ text: "/save" });
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: noOfferHistory,
      last_assistant_text: "Done.",
      model_invoker: invoker,
    });
    expect(result.kind).toBe("slash");
    expect(result.suggestion).toBe("/save");
  });

  test("empty model output is reported as 'empty'", async () => {
    const invoker: SuggestNextModelInvoker = async () => ({ text: "" });
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: noOfferHistory,
      last_assistant_text: "Done.",
      model_invoker: invoker,
    });
    expect(result.reason).toBe("empty");
    expect(result.suggestion).toBeNull();
  });

  test("filtered model output collapses to 'filtered'", async () => {
    const invoker: SuggestNextModelInvoker = async () => ({ text: "Let me handle it" });
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: noOfferHistory,
      last_assistant_text: "Done.",
      model_invoker: invoker,
    });
    expect(result.reason).toBe("filtered");
    expect(result.suggestion).toBeNull();
  });

  test("model invoker throw is swallowed → 'error', never rethrown", async () => {
    const invoker: SuggestNextModelInvoker = async () => {
      throw new Error("anthropic 503");
    };
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: noOfferHistory,
      last_assistant_text: "Done.",
      model_invoker: invoker,
    });
    expect(result.reason).toBe("error");
    expect(result.suggestion).toBeNull();
  });

  test("budget guard returning false → 'budget-pressure', no model call", async () => {
    let modelCalls = 0;
    const invoker: SuggestNextModelInvoker = async () => {
      modelCalls += 1;
      return { text: "x" };
    };
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: noOfferHistory,
      last_assistant_text: "Done.",
      budget_guard: () => false,
      model_invoker: invoker,
    });
    expect(result.reason).toBe("budget-pressure");
    expect(modelCalls).toBe(0);
  });

  test("missing model_invoker on a non-offer turn returns 'empty'", async () => {
    const result = await suggestNextMessage({
      tenant_id: "t",
      conversation_id: "c",
      recent_messages: noOfferHistory,
      last_assistant_text: "Done.",
    });
    expect(result.reason).toBe("empty");
    expect(result.suggestion).toBeNull();
  });
});
