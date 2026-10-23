import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, getConfig, loadConfig } from "../../../config/loader.ts";
import { RuntimeConfigCoordinator } from "../../../runtime-config/coordinator.ts";
import { initializeRuntimeConfig } from "../../../runtime-config/service.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let coordinator: RuntimeConfigCoordinator;
let configDir: string;
let previousMasterKey: string | undefined;

beforeAll(async () => {
  previousMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY = "22".repeat(32);
  process.env.NODE_ENV = "test";
  configDir = mkdtempSync(join(tmpdir(), "sk-runtime-hosted-"));
  _resetConfigForTests();
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/runtime-http",
      NODE_ENV: "test",
    },
    configPathOverride: join(configDir, "seed.json"),
  });
  server = await createHttpTestServer("runtime-config-hosted-models");
  await initializeRuntimeConfig(server.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(server.db, "test", "hosted-replica");
  await coordinator.start();
});

afterAll(async () => {
  await coordinator.stop();
  await server.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  if (previousMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = previousMasterKey;
});

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${server.apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

describe("hosted model allowlist revisions", () => {
  test("a disabled hosted model entry keeps its limits through save and activation", async () => {
    const entry = (model: string) => ({
      model,
      max_context_tokens: 200000,
      max_output_tokens: 8000,
      input_usd_per_million_tokens: "1",
      output_usd_per_million_tokens: "5",
      cache_read_usd_per_million_tokens: "0.1",
      cache_write_5m_usd_per_million_tokens: "1.25",
      cache_write_1h_usd_per_million_tokens: "2",
    });
    const models = [
      entry("openai:gpt-4.1-mini"),
      { ...entry("anthropic:claude-sonnet-5"), disabled: true },
    ];
    const listed = (await (await authedFetch("/v1/settings")).json()) as {
      saved_revision: number;
    };
    const saved = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: listed.saved_revision,
        changes: { "llm.hosted.models": models },
        scope: "global",
      }),
    });
    expect(saved.status).toBe(200);
    const state = (await saved.json()) as { saved_revision: number };
    const activated = await authedFetch(`/v1/settings/revisions/${state.saved_revision}/activate`, {
      method: "POST",
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      active_revision: state.saved_revision,
      activation_status: "active",
    });
    const revision = (await (
      await authedFetch(`/v1/settings/revisions/${state.saved_revision}`)
    ).json()) as { document: { llm: { hosted: { models: unknown[] } } } };
    expect(revision.document.llm.hosted.models).toEqual(models);
    const runtime = (await (await authedFetch("/v1/settings/runtime")).json()) as {
      active_revision: number;
      settings: { llm: { hosted: { models: unknown[] } } };
    };
    expect(runtime.active_revision).toBe(state.saved_revision);
    expect(runtime.settings.llm.hosted.models).toEqual(models);
  });
});
