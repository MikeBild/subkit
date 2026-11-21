import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { suggestionModelFor } from "../../../conversations/loop/suggest-next-emitter.ts";
import type { Executor } from "../../../db/client.ts";
import type { ModelRoute } from "../../types.ts";
import { probeModel } from "../access-probe.ts";
import { AiSdkModel } from "../ai-sdk-model.ts";
import {
  applyFlowEnvOverrides,
  applyFlowModelElevation,
  globalLlmStatus,
  resolveModelRoute,
} from "../invoke.ts";
import { initializeModel, ProviderMisconfiguredError } from "../model-init.ts";

const DB_URL = "postgres://x:y@127.0.0.1:5432/z";
const TENANT = "00000000-0000-4000-8000-000000000491";
let dir: string | null = null;

const noTenantRow = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
} as unknown as Executor;

async function useLlm(llm: Record<string, unknown>): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "sk-provider-default-"));
  const cfgPath = join(dir, "subkit.config.json");
  writeFileSync(cfgPath, JSON.stringify({ database: { url: DB_URL }, llm }));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: DB_URL, NODE_ENV: "test" },
    configPathOverride: cfgPath,
  });
}

afterEach(() => {
  _resetConfigForTests();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const OPENAI = { provider: "openai", model: "", providers: { openai: { api_key: "sk-test" } } };

function noClaude(values: string[]): void {
  for (const value of values) expect(value.startsWith("claude")).toBe(false);
}

describe("openai with an empty model", () => {
  test("the route uses the openai default for primary and fallback", async () => {
    await useLlm(OPENAI);
    const route = await resolveModelRoute(TENANT, noTenantRow);
    expect(route.provider).toBe("openai");
    expect(route.primary).toBe("gpt-4.1-mini");
    expect(route.fallback).toBe("gpt-4.1-mini");
    const status = globalLlmStatus();
    expect(status.default_primary).toBe("gpt-4.1-mini");
    expect(status.default_fallback).toBe("gpt-4.1-mini");
    expect(status.configuration_error).toBeNull();
  });

  test("elevated flows stay on the openai default", async () => {
    await useLlm(OPENAI);
    const route = await resolveModelRoute(TENANT, noTenantRow);
    for (const flow of ["judge", "generate", "converse"] as const) {
      const elevated = applyFlowModelElevation(route, flow);
      expect(elevated.primary).toBe("gpt-4.1-mini");
      noClaude([elevated.primary, elevated.fallback]);
    }
  });

  test("model initialisation picks the openai default", async () => {
    await useLlm(OPENAI);
    expect((await initializeModel()).modelId).toBe("gpt-4.1-mini");
    expect((await initializeModel({ defaultModel: "" })).modelId).toBe("gpt-4.1-mini");
    expect(new AiSdkModel({}).modelId).toBe("gpt-4.1-mini");
  });

  test("a model of another family is never sent to openai", async () => {
    await useLlm(OPENAI);
    const resolved = await initializeModel({
      defaultModel: "claude-sonnet-4-6",
      modelOverride: "claude-sonnet-4-6",
    });
    expect(resolved.modelId).toBe("gpt-4.1-mini");
  });

  test("a stale anthropic fallback and suggestion model fall back to the openai default", async () => {
    await useLlm({
      ...OPENAI,
      fallback_model: "claude-opus-4-7",
      suggestion_model: "claude-haiku-4-5",
    });
    const route = await resolveModelRoute(TENANT, noTenantRow);
    expect(route.fallback).toBe("gpt-4.1-mini");
    expect(applyFlowModelElevation(route, "judge").primary).toBe("gpt-4.1-mini");
    expect(suggestionModelFor(route, "claude-haiku-4-5")).toBe("gpt-4.1-mini");
    expect(suggestionModelFor(route, "")).toBe("gpt-4.1-mini");
    expect(probeModel("openai")).toBe("gpt-4.1-mini");
  });

  test("an elevated route carrying a foreign fallback still dispatches the openai default", async () => {
    await useLlm(OPENAI);
    const route = {
      tenant_id: TENANT,
      primary: "gpt-4.1-mini",
      fallback: "claude-opus-4-7",
      provider: "openai",
      fallback_provider: "openai",
      context_cap: 110_000,
    } as ModelRoute;
    const elevated = applyFlowModelElevation(route, "judge");
    const resolved = await initializeModel({
      providerOverride: elevated.provider,
      defaultModel: elevated.primary,
      modelOverride: elevated.primary,
    });
    expect(resolved.modelId).toBe("gpt-4.1-mini");
  });

  test("an openai-compatible endpoint keeps the configured model", async () => {
    await useLlm({
      provider: "openai",
      model: "claude-sonnet-4-6",
      providers: { openai: { api_key: "sk-test", base_url: "http://127.0.0.1:4000/v1" } },
    });
    expect((await initializeModel()).modelId).toBe("claude-sonnet-4-6");
  });
});

describe("anthropic with an empty model", () => {
  const ANTHROPIC = {
    provider: "anthropic",
    model: "",
    providers: { anthropic: { api_key: "sk-ant-test" } },
  };

  test("keeps the existing defaults", async () => {
    await useLlm(ANTHROPIC);
    const route = await resolveModelRoute(TENANT, noTenantRow);
    expect(route.primary).toBe("claude-sonnet-4-6");
    expect(route.fallback).toBe("claude-opus-4-7");
    expect(applyFlowModelElevation(route, "judge").primary).toBe("claude-opus-4-7");
    expect(suggestionModelFor(route, "")).toBe("claude-haiku-4-5");
    expect((await initializeModel()).modelId).toBe("claude-sonnet-4-6");
    expect(probeModel("anthropic")).toBe("claude-haiku-4-5");
  });
});

describe("providers without a catalog default", () => {
  test("azure without a model or deployment fails with a clear message", async () => {
    await useLlm({
      provider: "azure",
      model: "",
      providers: { azure: { api_key: "az-test", resource_name: "res" } },
    });
    const error = await initializeModel().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderMisconfiguredError);
    expect((error as ProviderMisconfiguredError).setting).toBe("AZURE_MODEL");
    expect(globalLlmStatus().default_primary).toBe("");
    expect(globalLlmStatus().configuration_error).toContain("AZURE_MODEL");
  });

  test("azure keeps its provider-specific deployment", async () => {
    await useLlm({
      provider: "azure",
      model: "",
      providers: { azure: { api_key: "az-test", resource_name: "res", model: "prod-gpt" } },
    });
    expect((await initializeModel()).modelId).toBe("prod-gpt");
    const route = await resolveModelRoute(TENANT, noTenantRow);
    expect(route.primary).toBe("prod-gpt");
    expect(suggestionModelFor(route, "")).toBe("prod-gpt");
  });
});

describe("summaries", () => {
  test("the saved summary model is used for the summarize flow", async () => {
    await useLlm({ ...OPENAI, summarize_model: "gpt-4.1-nano" });
    const route = await resolveModelRoute(TENANT, noTenantRow);
    const summarize = applyFlowEnvOverrides(route, "summarize");
    expect(summarize.provider).toBe("openai");
    expect(summarize.primary).toBe("gpt-4.1-nano");
    expect(applyFlowEnvOverrides(route, "converse").primary).toBe("gpt-4.1-mini");
  });

  test("another summary provider without a model uses that provider's default", async () => {
    await useLlm({ ...OPENAI, summarize_provider: "anthropic" });
    const route = await resolveModelRoute(TENANT, noTenantRow);
    const summarize = applyFlowEnvOverrides(route, "summarize");
    expect(summarize.provider).toBe("anthropic");
    expect(summarize.primary).toBe("claude-sonnet-4-6");
  });
});
