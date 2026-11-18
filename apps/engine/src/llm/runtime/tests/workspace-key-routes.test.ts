import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../../config/loader.ts";
import { detectConfiguredProvider, modelKeyOwner } from "../model-init.ts";

const OWN_KEY = "5d0c1c0e-4f43-4a53-9a0b-2f6f2f3b9a31";
const KEYLESS = "6b0b1c0e-4f43-4a53-9a0b-2f6f2f3b9a32";
const ROUTES = ["LLM_PROVIDER", "LLM_FALLBACK_PROVIDER", "SUMMARIZE_LLM_PROVIDER"];
let configDir: string;

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "sk-workspace-key-routes-"));
  const file = join(configDir, "subkit.config.json");
  writeFileSync(
    file,
    JSON.stringify({
      llm: {
        provider: "anthropic",
        fallback_provider: "gemini",
        summarize_provider: "anthropic",
        providers: {
          anthropic: { api_key: "sk-ant-operator-key" },
          gemini: { api_key: "operator-gemini-key" },
          ai_gateway: { api_key: "operator-gateway-key", model: "anthropic/claude-opus-4-7" },
        },
      },
    }),
  );
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/workspace-key-routes", NODE_ENV: "test" },
    configPathOverride: file,
  });
  const options = { tenantId: OWN_KEY, force: true };
  await setConfigKey(["llm", "provider"], "openai", options);
  await setConfigKey(["llm", "api_key"], "sk-workspace-own-key", options);
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

test("a workspace with its own key runs every route on its own provider", () => {
  for (const providerEnvVar of ROUTES) {
    const provider = detectConfiguredProvider({ providerEnvVar, tenantId: OWN_KEY });
    expect(provider).toBe("openai");
    if (provider === "openai") expect(modelKeyOwner(provider, OWN_KEY)).toBe("workspace");
  }
});

test("a workspace without its own key resolves to the operator's routes", () => {
  for (const providerEnvVar of ROUTES) {
    expect(detectConfiguredProvider({ providerEnvVar, tenantId: KEYLESS })).toBe("gateway");
  }
});
