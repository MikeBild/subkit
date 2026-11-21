import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import type { ModelRoute } from "../../types.ts";
import { applyFlowEnvOverrides } from "../invoke.ts";

const BASE_ROUTE: ModelRoute = {
  tenant_id: "00000000-0000-0000-0000-000000000000",
  primary: "claude-sonnet-4-5",
  fallback: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  fallback_provider: "anthropic",
  context_cap: 200_000,
};

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
    extract_provider: testEnv.EXTRACT_LLM_PROVIDER,
    extract_model: testEnv.EXTRACT_MODEL,
    generate_provider: testEnv.GENERATE_LLM_PROVIDER,
    generate_model: testEnv.GENERATE_MODEL,
    openai_key: testEnv.OPENAI_API_KEY,
  };
  delete testEnv.EXTRACT_LLM_PROVIDER;
  delete testEnv.EXTRACT_MODEL;
  delete testEnv.GENERATE_LLM_PROVIDER;
  delete testEnv.GENERATE_MODEL;
});

afterEach(() => {
  const restore = (key: keyof EnvSnapshot, envKey: string) => {
    const v = saved[key];
    if (v === undefined) delete testEnv[envKey];
    else testEnv[envKey] = v;
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
    testEnv.EXTRACT_MODEL = "claude-haiku-4-5-20251001";
    const out = applyFlowEnvOverrides(BASE_ROUTE, "extract");
    expect(out.primary).toBe("claude-haiku-4-5-20251001");
    expect(out.provider).toBe(BASE_ROUTE.provider);
  });

  test("{FLOW}_LLM_PROVIDER overrides the provider when fully configured", () => {
    testEnv.GENERATE_LLM_PROVIDER = "openai";
    testEnv.OPENAI_API_KEY = "sk-test";
    const out = applyFlowEnvOverrides(BASE_ROUTE, "generate");
    expect(out.provider).toBe("openai");
  });

  test("different flow names pick up disjoint env vars", () => {
    testEnv.EXTRACT_MODEL = "model-extract";
    testEnv.GENERATE_MODEL = "model-generate";
    expect(applyFlowEnvOverrides(BASE_ROUTE, "extract").primary).toBe("model-extract");
    expect(applyFlowEnvOverrides(BASE_ROUTE, "generate").primary).toBe("model-generate");
    expect(applyFlowEnvOverrides(BASE_ROUTE, "converse").primary).toBe(BASE_ROUTE.primary);
  });
});
