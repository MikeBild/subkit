import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../../config/loader.ts";
import { withContext } from "../../../logging/context.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import {
  buildAnthropicWebSearchTool,
  detectConfiguredProvider,
  initializeModel,
  nativeWebSearchSetting,
  ProviderMisconfiguredError,
  sendsToolInputExamplesNatively,
  withToolInputExamples,
} from "../model-init.ts";

const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_MODEL",
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "SUMMARIZE_LLM_PROVIDER",
  "SUMMARIZE_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "AZURE_API_KEY",
  "AZURE_MODEL",
  "AZURE_RESOURCE_NAME",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "BEDROCK_MODEL",
  "VERTEX_API_KEY",
  "VERTEX_MODEL",
] as const;

function snapshotEnv() {
  for (const k of TRACKED) SAVED_ENV[k] = testEnv[k];
}
function restoreEnv() {
  for (const k of TRACKED) {
    const v = SAVED_ENV[k];
    if (v === undefined) {
      delete testEnv[k];
    } else {
      testEnv[k] = v;
    }
  }
}
function clearEnv() {
  for (const k of TRACKED) delete testEnv[k];
}

const OPENAI_CHAT_TRANSPORT = "openai.chat";
const OPENAI_RESPONSES_TRANSPORT = "openai.responses";
function modelTransport(model: unknown): string {
  return (model as { provider: string }).provider;
}

describe("initializeModel", () => {
  let configDir: string | null = null;

  beforeEach(() => {
    snapshotEnv();
    clearEnv();
    _resetConfigForTests();
  });
  afterEach(() => {
    restoreEnv();
    _resetConfigForTests();
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
      configDir = null;
    }
  });

  it("returns the mock sentinel when LLM_PROVIDER=mock", async () => {
    testEnv.LLM_PROVIDER = "mock";
    const r = await initializeModel();
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock:never-dispatched");
  });

  it("rejects a model tenant that differs from the authenticated context", async () => {
    await withContext({ tenant_id: "tenant-a" }, async () => {
      await expect(
        initializeModel({ providerOverride: "mock", tenantId: "tenant-b" }),
      ).rejects.toThrow("do not match");
    });
  });

  it("returns the mock sentinel when providerOverride=mock", async () => {
    const r = await initializeModel({ providerOverride: "mock" });
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock:never-dispatched");
  });

  it("prefers gateway mode when both gateway vars are set", async () => {
    testEnv.LLM_PROVIDER = "anthropic";
    testEnv.ANTHROPIC_API_KEY = "sk-ant-test";
    testEnv.AI_GATEWAY_API_KEY = "gw-key";
    testEnv.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    const r = await initializeModel();
    expect(r.provider).toBe("gateway");
    expect(r.modelId).toBe("anthropic/claude-sonnet-4-5");
    expect(r.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns a direct anthropic model when LLM_PROVIDER=anthropic", async () => {
    testEnv.LLM_PROVIDER = "anthropic";
    testEnv.ANTHROPIC_API_KEY = "sk-ant-test";
    testEnv.ANTHROPIC_MODEL = "claude-sonnet-4-5";
    const r = await initializeModel();
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(typeof r.model).toBe("object");
  });

  it("returns a direct openai model when LLM_PROVIDER=openai", async () => {
    testEnv.LLM_PROVIDER = "openai";
    testEnv.OPENAI_API_KEY = "sk-openai-test";
    testEnv.OPENAI_MODEL = "gpt-4.1";
    const r = await initializeModel();
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-4.1");
    expect(typeof r.model).toBe("object");
  });

  it("pins chat completions for an OpenAI-compatible custom base URL", async () => {
    testEnv.LLM_PROVIDER = "openai";
    testEnv.OPENAI_API_KEY = "subkit-compat-test";
    testEnv.OPENAI_MODEL = "qwen-3-32b";
    testEnv.OPENAI_BASE_URL = "https://llm.internal.example/v1";
    const r = await initializeModel();
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("qwen-3-32b");
    expect(modelTransport(r.model)).toBe(OPENAI_CHAT_TRANSPORT);
  });

  it("keeps the Responses API for real OpenAI (no base URL) — no regression", async () => {
    testEnv.LLM_PROVIDER = "openai";
    testEnv.OPENAI_API_KEY = "sk-openai-test";
    testEnv.OPENAI_MODEL = "gpt-4.1";
    const r = await initializeModel();
    expect(modelTransport(r.model)).toBe(OPENAI_RESPONSES_TRANSPORT);
  });

  it("honours providerOverride over env-driven gateway selection", async () => {
    testEnv.AI_GATEWAY_API_KEY = "gw-key";
    testEnv.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    testEnv.OPENAI_API_KEY = "sk-openai-test";
    const r = await initializeModel({
      providerOverride: "openai",
      modelOverride: "gpt-4.1",
    });
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-4.1");
    expect(typeof r.model).toBe("object");
  });

  it("throws when gateway is selected but AI_GATEWAY_MODEL is missing", async () => {
    testEnv.AI_GATEWAY_API_KEY = "gw-key";
    await expect(initializeModel({ providerOverride: "gateway" })).rejects.toBeInstanceOf(
      ProviderMisconfiguredError,
    );
  });

  it("throws when LLM_PROVIDER is set but the matching key is missing", async () => {
    testEnv.LLM_PROVIDER = "anthropic";
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("throws when neither gateway nor a provider env is configured", async () => {
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("honours providerEnvVar override for mock", async () => {
    testEnv.SUMMARIZE_LLM_PROVIDER = "mock";
    const r = await initializeModel({ providerEnvVar: "SUMMARIZE_LLM_PROVIDER" });
    expect(r.provider).toBe("mock");
    delete testEnv.SUMMARIZE_LLM_PROVIDER;
  });

  it("uses tenant-effective provider selection and credentials", async () => {
    configDir = mkdtempSync(join(tmpdir(), "subkit-model-init-tenant-"));
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: join(configDir, "subkit.config.json"),
    });

    await setConfigKey("llm.provider", "anthropic", { tenantId: "tenant-a", force: true });
    await setConfigKey("llm.api_key", "tenant-ant-key", { tenantId: "tenant-a", force: true });
    await setConfigKey("llm.model", "claude-sonnet-4-5", { tenantId: "tenant-a", force: true });

    expect(detectConfiguredProvider()).toBe("mock");
    expect(detectConfiguredProvider({ tenantId: "tenant-a" })).toBe("anthropic");

    const r = await initializeModel({ tenantId: "tenant-a" });
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(typeof r.model).toBe("object");
  });

  it("native web search follows the tenant-effective setting", async () => {
    configDir = mkdtempSync(join(tmpdir(), "subkit-model-search-policy-"));
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: join(configDir, "subkit.config.json"),
    });
    expect(nativeWebSearchSetting("tenant-a")).toBe(true);
    await setConfigKey("llm.web_search", false, { tenantId: "tenant-a", force: true });
    expect(nativeWebSearchSetting("tenant-a")).toBe(false);
    expect(nativeWebSearchSetting()).toBe(true);
    await setConfigKey("llm.web_search", false, { force: true });
    await setConfigKey("llm.web_search", true, { tenantId: "tenant-a", force: true });
    expect(nativeWebSearchSetting("tenant-a")).toBe(true);
    expect(nativeWebSearchSetting()).toBe(false);
  });

  it("builds web search with tenant credentials without borrowing another tenant's key", async () => {
    configDir = mkdtempSync(join(tmpdir(), "subkit-web-search-tenant-"));
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: join(configDir, "subkit.config.json"),
    });
    await setConfigKey("llm.providers.anthropic.api_key", "tenant-ant-key", {
      tenantId: "tenant-a",
      force: true,
    });

    expect(() => buildAnthropicWebSearchTool(5)).toThrow(ProviderMisconfiguredError);
    expect(() => buildAnthropicWebSearchTool(5, "tenant-b")).toThrow(ProviderMisconfiguredError);
    expect(buildAnthropicWebSearchTool(5, "tenant-a")).toMatchObject({
      type: "provider",
      id: "anthropic.web_search_20250305",
      args: { maxUses: 5 },
    });
  });

  it("does not fall back to legacy env vars after config has explicitly cleared a leaf", async () => {
    testEnv.LLM_PROVIDER = "anthropic";
    testEnv.ANTHROPIC_API_KEY = "env-ant-key";
    configDir = mkdtempSync(join(tmpdir(), "subkit-model-init-cleared-"));
    await loadConfig({
      env: {
        DATABASE_URL: "postgres://x",
        NODE_ENV: "test",
        ANTHROPIC_API_KEY: testEnv.ANTHROPIC_API_KEY,
        LLM_PROVIDER: testEnv.LLM_PROVIDER,
      },
      configPathOverride: join(configDir, "subkit.config.json"),
    });

    await setConfigKey("llm.provider", "anthropic", { force: true });
    await setConfigKey("llm.api_key", "", { force: true });

    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });
});

type ModelObject = Pick<MockLanguageModelV4, "doGenerate">;
type CallOptions = Parameters<ModelObject["doGenerate"]>[0];

describe("withToolInputExamples", () => {
  const EXAMPLE = { scope: "global", title: "Backoff on 429" };

  function recordingModel(): { model: MockLanguageModelV4; seen: CallOptions[] } {
    const seen: CallOptions[] = [];
    const model = new MockLanguageModelV4({
      provider: "mock-provider",
      modelId: "mock-model",
      doGenerate: async (options) => {
        seen.push(options);
        return {
          content: [],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    return { model, seen };
  }

  function callWithExampleTool(): CallOptions {
    return {
      prompt: [{ role: "user", content: [{ type: "text", text: "propose a skill" }] }],
      tools: [
        {
          type: "function",
          name: "propose_skill",
          description: "Propose a skill.",
          inputSchema: { type: "object", properties: {} },
          inputExamples: [{ input: EXAMPLE }],
        },
      ],
    };
  }

  it("names the providers that send input_examples on the wire themselves", () => {
    expect(sendsToolInputExamplesNatively("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(sendsToolInputExamplesNatively("vertex", "claude-sonnet-4-6")).toBe(true);
    expect(sendsToolInputExamplesNatively("vertex", "gemini-2.5-pro")).toBe(false);
    expect(sendsToolInputExamplesNatively("bedrock", "anthropic.claude-sonnet-4-6")).toBe(false);
    expect(sendsToolInputExamplesNatively("openai", "gpt-5.6")).toBe(false);
    expect(sendsToolInputExamplesNatively("gemini", "gemini-2.5-pro")).toBe(false);
    expect(sendsToolInputExamplesNatively("azure", "gpt-5.6")).toBe(false);
  });

  it("appends the example to the tool description for a provider without native support", async () => {
    const { model, seen } = recordingModel();
    const wrapped = withToolInputExamples(model, "openai", "gpt-5.6") as ModelObject;
    expect(wrapped).not.toBe(model);

    await wrapped.doGenerate(callWithExampleTool());

    const sent = seen[0]!.tools?.[0];
    expect(sent?.type).toBe("function");
    if (sent?.type !== "function") throw new Error("expected a function tool");
    expect(sent.description).toContain("Propose a skill.");
    expect(sent.description).toContain("Input Examples:");
    expect(sent.description).toContain(JSON.stringify(EXAMPLE));
    expect(sent.inputExamples).toBeUndefined();
  });

  it("leaves an Anthropic model untouched so input_examples travel natively", async () => {
    const { model, seen } = recordingModel();
    const passedThrough = withToolInputExamples(model, "anthropic", "claude-sonnet-4-6");
    expect(passedThrough).toBe(model);

    await (passedThrough as ModelObject).doGenerate(callWithExampleTool());

    const sent = seen[0]!.tools?.[0];
    if (sent?.type !== "function") throw new Error("expected a function tool");
    expect(sent.description).toBe("Propose a skill.");
    expect(sent.inputExamples).toEqual([{ input: EXAMPLE }]);
  });

  it("returns a gateway model id unwrapped", () => {
    expect(withToolInputExamples("anthropic/claude-sonnet-4-6", "gateway", "x")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });
});
