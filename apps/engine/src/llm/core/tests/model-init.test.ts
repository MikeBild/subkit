import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../../config/loader.ts";
import {
  detectConfiguredProvider,
  initializeModel,
  ProviderMisconfiguredError,
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
  for (const k of TRACKED) SAVED_ENV[k] = process.env[k];
}
function restoreEnv() {
  for (const k of TRACKED) {
    const v = SAVED_ENV[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}
function clearEnv() {
  for (const k of TRACKED) delete process.env[k];
}

// The transport an AI-SDK model dispatches over. `@ai-sdk/openai` (pinned at
// 3.0.x) tags chat-completions models `openai.chat` and Responses-API models
// `openai.responses` on the public `provider` field — the cleanest stable
// signal for which route resolveOpenAi pinned, without standing up an HTTP
// stub. If a future SDK bump re-tags these, update the two constants below —
// they are the single grep target for both assertions.
const OPENAI_CHAT_TRANSPORT = "openai.chat"; // POST /chat/completions
const OPENAI_RESPONSES_TRANSPORT = "openai.responses"; // POST /v1/responses
function modelTransport(model: unknown): string {
  return (model as { provider: string }).provider;
}

describe("initializeModel", () => {
  let configDir: string | null = null;

  beforeEach(() => {
    snapshotEnv();
    clearEnv();
    // v3.5: drop any config state leaked from earlier suites; readEnv
    // reads getConfig() first and the schema's "mock" default would
    // override these env-driven assertions otherwise.
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
    process.env.LLM_PROVIDER = "mock";
    const r = await initializeModel();
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock:never-dispatched");
  });

  it("returns the mock sentinel when providerOverride=mock", async () => {
    const r = await initializeModel({ providerOverride: "mock" });
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock:never-dispatched");
  });

  it("prefers gateway mode when both gateway vars are set", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    const r = await initializeModel();
    expect(r.provider).toBe("gateway");
    expect(r.modelId).toBe("anthropic/claude-sonnet-4-5");
    expect(r.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns a direct anthropic model when LLM_PROVIDER=anthropic", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-5";
    const r = await initializeModel();
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toBe("claude-sonnet-4-5");
    expect(typeof r.model).toBe("object");
  });

  it("returns a direct openai model when LLM_PROVIDER=openai", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.OPENAI_MODEL = "gpt-4.1";
    const r = await initializeModel();
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-4.1");
    expect(typeof r.model).toBe("object");
  });

  it("pins chat completions for an OpenAI-compatible custom base URL", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-compat-test";
    process.env.OPENAI_MODEL = "qwen-3-32b";
    process.env.OPENAI_BASE_URL = "https://llm.internal.example/v1";
    const r = await initializeModel();
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("qwen-3-32b");
    // `.chat()` builds an `openai.chat` model (POST /chat/completions); the
    // default callable would be `openai.responses` (POST /v1/responses), which
    // a custom OpenAI-compatible host does not implement.
    expect(modelTransport(r.model)).toBe(OPENAI_CHAT_TRANSPORT);
  });

  it("keeps the Responses API for real OpenAI (no base URL) — no regression", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.OPENAI_MODEL = "gpt-4.1";
    const r = await initializeModel();
    expect(modelTransport(r.model)).toBe(OPENAI_RESPONSES_TRANSPORT);
  });

  it("honours providerOverride over env-driven gateway selection", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-sonnet-4-5";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const r = await initializeModel({
      providerOverride: "openai",
      modelOverride: "gpt-4.1",
    });
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-4.1");
    expect(typeof r.model).toBe("object");
  });

  it("throws when gateway is selected but AI_GATEWAY_MODEL is missing", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    await expect(initializeModel({ providerOverride: "gateway" })).rejects.toBeInstanceOf(
      ProviderMisconfiguredError,
    );
  });

  it("throws when LLM_PROVIDER is set but the matching key is missing", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("throws when neither gateway nor a provider env is configured", async () => {
    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });

  it("honours providerEnvVar override for mock", async () => {
    process.env.CUSTOM_PROVIDER = "mock";
    const r = await initializeModel({ providerEnvVar: "CUSTOM_PROVIDER" });
    expect(r.provider).toBe("mock");
    delete process.env.CUSTOM_PROVIDER;
  });

  it("uses tenant-effective provider selection and credentials", async () => {
    configDir = mkdtempSync(join(tmpdir(), "sk-model-init-tenant-"));
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

  it("does not fall back to legacy env vars after config has explicitly cleared a leaf", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "env-ant-key";
    configDir = mkdtempSync(join(tmpdir(), "sk-model-init-cleared-"));
    await loadConfig({
      env: {
        DATABASE_URL: "postgres://x",
        NODE_ENV: "test",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        LLM_PROVIDER: process.env.LLM_PROVIDER,
      },
      configPathOverride: join(configDir, "subkit.config.json"),
    });

    await setConfigKey("llm.provider", "anthropic", { force: true });
    await setConfigKey("llm.api_key", "", { force: true });

    await expect(initializeModel()).rejects.toBeInstanceOf(ProviderMisconfiguredError);
  });
});
