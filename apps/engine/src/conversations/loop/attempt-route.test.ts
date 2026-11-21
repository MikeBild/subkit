import { describe, expect, test } from "bun:test";
import type { ModelRoute } from "../../llm/types.ts";
import { resolveConversationAttemptRoutes } from "./attempt-route.ts";

describe("conversation attempt routing", () => {
  test("pairs a cross-provider fallback model with its fallback provider", () => {
    const route: ModelRoute = {
      tenant_id: "tenant-a",
      primary: "claude-haiku-4-5",
      fallback: "gpt-5.6-sol",
      provider: "anthropic",
      fallback_provider: "openai",
      context_cap: 200_000,
    };

    expect(resolveConversationAttemptRoutes(route, "claude-sonnet-4-6")).toEqual({
      primary: { model: "claude-sonnet-4-6", provider: "anthropic" },
      fallback: { model: "gpt-5.6-sol", provider: "openai" },
    });
  });

  test("preserves same-provider fallback routing", () => {
    const route: ModelRoute = {
      tenant_id: "tenant-a",
      primary: "primary",
      fallback: "fallback",
      provider: "mock",
      fallback_provider: "mock",
      context_cap: 100_000,
    };

    expect(resolveConversationAttemptRoutes(route, route.primary).fallback).toEqual({
      model: "fallback",
      provider: "mock",
    });
  });
});
