import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { initializeModel } from "./model-init.ts";
import { workspaceAiAccess, workspaceKeyModel } from "./workspace-access.ts";

const WORKSPACE = "7d0c1c0e-4f43-4a53-9a0b-2f6f2f3b9a11";
const KEYLESS = "0b0b1c0e-4f43-4a53-9a0b-2f6f2f3b9a22";
let configDir: string;

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "sk-workspace-key-model-"));
  const file = join(configDir, "subkit.config.json");
  writeFileSync(
    file,
    JSON.stringify({
      llm: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        providers: { anthropic: { model: "claude-opus-4-7", api_key: "sk-ant-operator-key" } },
      },
    }),
  );
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/workspace-key-model", NODE_ENV: "test" },
    configPathOverride: file,
  });
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

async function storeOverlay(model: string): Promise<void> {
  const options = { tenantId: WORKSPACE, force: true };
  await setConfigKey(["llm", "provider"], "anthropic", options);
  await setConfigKey(["llm", "model"], model, options);
  await setConfigKey(["llm", "api_key"], "sk-ant-workspace-own-key", options);
}

test("without a chosen model the key check names the model the workspace will call, not the operator's", async () => {
  await storeOverlay("");
  const runtime = await initializeModel({ tenantId: WORKSPACE });
  expect(runtime.provider).toBe("anthropic");
  expect(runtime.modelId).not.toBe("claude-opus-4-7");
  expect(workspaceKeyModel("anthropic")).toBe(runtime.modelId);
  expect(workspaceKeyModel("anthropic", null)).toBe(runtime.modelId);
});

test("a chosen model is the model the workspace will call", async () => {
  await storeOverlay("claude-haiku-4-5");
  const runtime = await initializeModel({ tenantId: WORKSPACE });
  expect(workspaceKeyModel("anthropic", " claude-haiku-4-5 ")).toBe(runtime.modelId);
});

test("a self-service workspace has AI access only with its own key", async () => {
  expect(workspaceAiAccess({ id: KEYLESS, origin: "self_service" })).toEqual({
    configured: false,
    provider: "anthropic",
    model: null,
    own_key: false,
  });
  await storeOverlay("claude-haiku-4-5");
  expect(workspaceAiAccess({ id: WORKSPACE, origin: "self_service" })).toEqual({
    configured: true,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    own_key: true,
  });
});

test("a self-hosted workspace has AI access through the engine settings", () => {
  expect(workspaceAiAccess({ id: KEYLESS, origin: "self_hosted" })).toEqual({
    configured: true,
    provider: "anthropic",
    model: null,
    own_key: false,
  });
});
