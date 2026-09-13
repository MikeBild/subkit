// Unit tests for the web-search tool gating logic that lives in
// `conversations/loop.ts` inside `runOnce`.
//
// The gate has three independent conditions:
//   1. route.provider === "anthropic"
//   2. /claude/i.test(modelId)
//   3. getConfig(tenant_id).llm.web_search === true
//
// All three must hold for the gate to open. The `getConfig` call is
// wrapped in a try/catch that returns false when the loader is not
// initialised (unit tests), so we replicate that guard here to test
// all branches purely.
//
// The `buildAnthropicWebSearchTool` function itself requires real
// Anthropic credentials and calls into `@ai-sdk/anthropic`; it is NOT
// exercised here. This file only asserts the gate predicate — which
// keys off provider + model regex + config flag — is computed correctly.

import { describe, expect, test } from "bun:test";

import { anthropicWebSearchApplies } from "../../llm/core/model-init.ts";

// Exercise the REAL exported gate predicate (no re-implemented copy). The
// loop resolves `getConfig(tenant_id).llm.web_search` (or false when the
// loader is uninitialised) into a boolean BEFORE calling the predicate, so
// here `webSearch: undefined` maps to the resolved `false`.
//   provider    — route.provider (the string returned by detectConfiguredProvider)
//   modelId     — the effective model id for this turn
//   webSearch   — the resolved llm.web_search boolean (undefined → false)
function webSearchGate(opts: {
  provider: string;
  modelId: string;
  webSearch: boolean | undefined;
}): boolean {
  return anthropicWebSearchApplies(opts.provider, opts.modelId, opts.webSearch === true);
}

// ---------------------------------------------------------------------------

describe("webSearchGate — provider guard", () => {
  test("mock provider → gate closed regardless of model or config", () => {
    expect(webSearchGate({ provider: "mock", modelId: "claude-sonnet-4-6", webSearch: true })).toBe(
      false,
    );
  });

  test("openai provider → gate closed", () => {
    expect(
      webSearchGate({ provider: "openai", modelId: "claude-sonnet-4-6", webSearch: true }),
    ).toBe(false);
  });

  test("gemini provider → gate closed", () => {
    expect(
      webSearchGate({ provider: "gemini", modelId: "claude-sonnet-4-6", webSearch: true }),
    ).toBe(false);
  });

  test("bedrock provider → gate closed (claude on bedrock does not use Anthropic web-search tool)", () => {
    expect(
      webSearchGate({ provider: "bedrock", modelId: "claude-3-sonnet", webSearch: true }),
    ).toBe(false);
  });

  test("vertex provider → gate closed", () => {
    expect(
      webSearchGate({ provider: "vertex", modelId: "claude-3-opus-20240229", webSearch: true }),
    ).toBe(false);
  });
});

describe("webSearchGate — model regex guard", () => {
  test("non-claude model on anthropic → gate closed", () => {
    expect(webSearchGate({ provider: "anthropic", modelId: "gpt-4o", webSearch: true })).toBe(
      false,
    );
  });

  test("model id 'claude-sonnet-4-6' on anthropic → gate open when config true", () => {
    expect(
      webSearchGate({ provider: "anthropic", modelId: "claude-sonnet-4-6", webSearch: true }),
    ).toBe(true);
  });

  test("model id 'claude-haiku-4-5' on anthropic → gate open when config true", () => {
    expect(
      webSearchGate({ provider: "anthropic", modelId: "claude-haiku-4-5", webSearch: true }),
    ).toBe(true);
  });

  test("model id 'claude-opus-4' on anthropic → gate open when config true", () => {
    expect(
      webSearchGate({ provider: "anthropic", modelId: "claude-opus-4", webSearch: true }),
    ).toBe(true);
  });

  test("model id 'Claude-Sonnet' (capital C) matches case-insensitively", () => {
    expect(
      webSearchGate({ provider: "anthropic", modelId: "Claude-Sonnet", webSearch: true }),
    ).toBe(true);
  });
});

describe("webSearchGate — config leaf guard", () => {
  test("web_search:false → gate closed even on anthropic + claude", () => {
    expect(
      webSearchGate({ provider: "anthropic", modelId: "claude-sonnet-4-6", webSearch: false }),
    ).toBe(false);
  });

  test("web_search:true → gate open on anthropic + claude", () => {
    expect(
      webSearchGate({ provider: "anthropic", modelId: "claude-sonnet-4-6", webSearch: true }),
    ).toBe(true);
  });

  test("web_search:undefined (loader not initialised) → gate closed gracefully", () => {
    expect(
      webSearchGate({ provider: "anthropic", modelId: "claude-sonnet-4-6", webSearch: undefined }),
    ).toBe(false);
  });
});

describe("webSearchGate — full matrix sanity", () => {
  // Exhaustive cross-product for the high-signal combinations.
  const cases: Array<{
    label: string;
    provider: string;
    modelId: string;
    webSearch: boolean | undefined;
    expected: boolean;
  }> = [
    {
      label: "anthropic + claude + true → open",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      webSearch: true,
      expected: true,
    },
    {
      label: "anthropic + claude + false → closed",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      webSearch: false,
      expected: false,
    },
    {
      label: "anthropic + non-claude + true → closed",
      provider: "anthropic",
      modelId: "gpt-4o",
      webSearch: true,
      expected: false,
    },
    {
      label: "mock + claude + true → closed",
      provider: "mock",
      modelId: "claude-sonnet-4-6",
      webSearch: true,
      expected: false,
    },
    {
      label: "anthropic + claude + undefined (no loader) → closed",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      webSearch: undefined,
      expected: false,
    },
  ];

  for (const { label, provider, modelId, webSearch, expected } of cases) {
    test(label, () => {
      expect(webSearchGate({ provider, modelId, webSearch })).toBe(expected);
    });
  }
});
