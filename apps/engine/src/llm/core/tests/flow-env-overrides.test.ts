import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ModelRoute } from "../../types.ts";
import { applyFlowEnvOverrides } from "../invoke.ts";

const BASE_ROUTE: ModelRoute = {
  tenant_id: "00000000-0000-0000-0000-000000000000",
  primary: "claude-sonnet-4-5",
  fallback: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  fallback_provider: "anthropic",
  context_cap: 200_000,
  monthly_budget: null,
  enable_prompt_cache: false,
};

// Capture and restore per-flow env overrides so the test suite stays hermetic.
// detectConfiguredProvider also reads ANTHROPIC_API_KEY etc. so we set it
// explicitly for the "provider override" path.
interface EnvSnapshot {
  extract_provider?: string | undefined;
  extract_model?: string | undefined;
  generate_provider?: string | undefined;
  generate_model?: string | undefined;
  openai_key?: string | undefined;
}

let saved: EnvSnapshot;

beforeEach(() => {
  saved = {
    extract_provider: process.env.EXTRACT_LLM_PROVIDER,
    extract_model: process.env.EXTRACT_MODEL,
    generate_provider: process.env.GENERATE_LLM_PROVIDER,
    generate_model: process.env.GENERATE_MODEL,
    openai_key: process.env.OPENAI_API_KEY,
  };
  delete process.env.EXTRACT_LLM_PROVIDER;
  delete process.env.EXTRACT_MODEL;
  delete process.env.GENERATE_LLM_PROVIDER;
  delete process.env.GENERATE_MODEL;
});

afterEach(() => {
  const restore = (key: keyof EnvSnapshot, envKey: string) => {
    const v = saved[key];
    if (v === undefined) delete process.env[envKey];
    else process.env[envKey] = v;
  };
  restore("extract_provider", "EXTRACT_LLM_PROVIDER");
  restore("extract_model", "EXTRACT_MODEL");
  restore("generate_provider", "GENERATE_LLM_PROVIDER");
  restore("generate_model", "GENERATE_MODEL");
  restore("openai_key", "OPENAI_API_KEY");
});

describe("applyFlowEnvOverrides", () => {
  test("no env overrides → route is returned unchanged", () => {
    const out = applyFlowEnvOverrides(BASE_ROUTE, "extract");
    expect(out.primary).toBe(BASE_ROUTE.primary);
    expect(out.provider).toBe(BASE_ROUTE.provider);
  });

  test("{FLOW}_MODEL overrides the primary model", () => {
    process.env.EXTRACT_MODEL = "claude-haiku-4-5-20251001";
    const out = applyFlowEnvOverrides(BASE_ROUTE, "extract");
    expect(out.primary).toBe("claude-haiku-4-5-20251001");
    // Provider unchanged when only the model is overridden.
    expect(out.provider).toBe(BASE_ROUTE.provider);
  });

  test("{FLOW}_LLM_PROVIDER overrides the provider when fully configured", () => {
    process.env.GENERATE_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    const out = applyFlowEnvOverrides(BASE_ROUTE, "generate");
    expect(out.provider).toBe("openai");
  });

  test("different flow names pick up disjoint env vars", () => {
    process.env.EXTRACT_MODEL = "model-extract";
    process.env.GENERATE_MODEL = "model-generate";
    expect(applyFlowEnvOverrides(BASE_ROUTE, "extract").primary).toBe("model-extract");
    expect(applyFlowEnvOverrides(BASE_ROUTE, "generate").primary).toBe("model-generate");
    expect(applyFlowEnvOverrides(BASE_ROUTE, "converse").primary).toBe(BASE_ROUTE.primary);
  });
});
