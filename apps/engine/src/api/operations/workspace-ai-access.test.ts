import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { DEFAULT_MODELS } from "../../llm/model-catalog-view.ts";
import type { LlmAccessProbe, LlmAccessRequest } from "../../llm/runtime/access-probe.ts";
import { checkLlmAccess } from "./workspace-ai-access.ts";

let configDir: string | null = null;

async function operatorConfig(llm: Record<string, unknown>): Promise<void> {
  configDir = mkdtempSync(join(tmpdir(), "sk-workspace-ai-access-"));
  const file = join(configDir, "subkit.config.json");
  writeFileSync(file, JSON.stringify({ llm }));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/workspace-ai-access", NODE_ENV: "test" },
    configPathOverride: file,
  });
}

afterEach(() => {
  _resetConfigForTests();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = null;
});

function recordingProbe(): { requests: LlmAccessRequest[]; probe: LlmAccessProbe } {
  const requests: LlmAccessRequest[] = [];
  return {
    requests,
    probe: async (request) => {
      requests.push(request);
      return { ok: true, model: request.model ?? null };
    },
  };
}

describe("checking a workspace's own provider key", () => {
  test("without a chosen model the check calls the provider's default, not the operator's model", async () => {
    await operatorConfig({
      provider: "anthropic",
      model: "claude-opus-4-7",
      providers: { anthropic: { model: "claude-opus-4-7" } },
    });
    const { requests, probe } = recordingProbe();
    expect(await checkLlmAccess({ provider: "anthropic", api_key: "sk-ant-own" }, probe)).toEqual({
      ok: true,
    });
    expect(requests).toEqual([
      { provider: "anthropic", api_key: "sk-ant-own", model: DEFAULT_MODELS.anthropic.primary },
    ]);
  });

  test("a chosen model is the one that is checked", async () => {
    await operatorConfig({ provider: "anthropic", model: "claude-opus-4-7" });
    const { requests, probe } = recordingProbe();
    await checkLlmAccess(
      { provider: "anthropic", api_key: "sk-ant-own", model: "claude-haiku-4-5" },
      probe,
    );
    expect(requests.map((request) => request.model)).toEqual(["claude-haiku-4-5"]);
  });

  test("an operator gateway does not stand in the way of an own key", async () => {
    await operatorConfig({
      provider: "anthropic",
      providers: { ai_gateway: { api_key: "gateway-key", model: "anthropic/claude-sonnet-4-6" } },
    });
    const { requests, probe } = recordingProbe();
    const accepted = await checkLlmAccess({ provider: "anthropic", api_key: "sk-ant-own" }, probe);
    expect(accepted).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
  });
});
