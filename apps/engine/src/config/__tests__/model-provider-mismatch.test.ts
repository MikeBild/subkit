import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import {
  _resetConfigForTests,
  getConfig,
  loadConfig,
  modelSettingMismatch,
  setConfigKey,
} from "../loader.ts";
import { ConfigSchema } from "../schema.ts";

const DB_URL = "postgres://x:y@127.0.0.1:5432/z";
const TENANT = "00000000-0000-4000-8000-000000000492";
let dir: string | null = null;

async function useConfig(doc: Record<string, unknown>): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "sk-model-mismatch-"));
  const cfgPath = join(dir, "subkit.config.json");
  writeFileSync(cfgPath, JSON.stringify({ database: { url: DB_URL }, ...doc }));
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

async function rejection(path: string, value: string, tenantId?: string): Promise<unknown> {
  return setConfigKey(path, value, tenantId ? { tenantId } : {}).then(
    () => null,
    (err: unknown) => err,
  );
}

describe("saving a model of another provider family", () => {
  test("rejects anthropic models for an openai provider with a clear message", async () => {
    await useConfig({ llm: { provider: "openai" } });
    for (const path of [
      "llm.model",
      "llm.fallback_model",
      "llm.summarize_model",
      "llm.suggestion_model",
    ]) {
      const err = await rejection(path, "claude-sonnet-4-6");
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain("anthropic model");
      expect((err as ValidationError).message).toContain("gpt-4.1-mini");
    }
    expect(getConfig().llm.model).toBe("");
  });

  test("accepts matching, empty and unknown models", async () => {
    await useConfig({ llm: { provider: "openai" } });
    expect(await rejection("llm.model", "gpt-4.1")).toBeNull();
    expect(await rejection("llm.suggestion_model", "")).toBeNull();
    expect(await rejection("llm.model", "o3-mini")).toBeNull();
    expect(await rejection("llm.model", "own-model")).toBeNull();
  });

  test("recognises OpenAI o-series models for provider validation", async () => {
    await useConfig({ llm: { provider: "anthropic" } });
    expect(await rejection("llm.model", "o3-mini")).toBeInstanceOf(ValidationError);
    expect(await rejection("llm.model", "openai:o1-preview")).toBeInstanceOf(ValidationError);
  });

  test("checks fallback and summarize models against their own provider", async () => {
    await useConfig({
      llm: { provider: "openai", fallback_provider: "anthropic", summarize_provider: "gemini" },
    });
    expect(await rejection("llm.fallback_model", "claude-opus-4-7")).toBeNull();
    expect(await rejection("llm.fallback_model", "gpt-4.1")).toBeInstanceOf(ValidationError);
    expect(await rejection("llm.summarize_model", "gemini-2.5-flash")).toBeNull();
    expect(await rejection("llm.summarize_model", "claude-haiku-4-5")).toBeInstanceOf(
      ValidationError,
    );
  });

  test("uses the tenant's provider for tenant writes", async () => {
    await useConfig({
      llm: { provider: "anthropic" },
      tenants: { [TENANT]: { llm: { provider: "openai" } } },
    });
    expect(await rejection("llm.model", "claude-sonnet-4-6", TENANT)).toBeInstanceOf(
      ValidationError,
    );
    expect(await rejection("llm.model", "claude-sonnet-4-6")).toBeNull();
  });

  test("leaves providers without a catalog family alone", async () => {
    await useConfig({ llm: { provider: "vertex" } });
    expect(await rejection("llm.model", "claude-sonnet-4-6")).toBeNull();
  });
});

describe("checking a saved runtime revision", () => {
  const revision = ConfigSchema.parse({
    database: { url: DB_URL },
    llm: { provider: "openai" },
    tenants: { [TENANT]: { llm: { model: "claude-sonnet-4-6" } } },
  });

  test("rejects a tenant model that does not fit the inherited provider", () => {
    expect(modelSettingMismatch(revision, ["llm", "model"], "claude-sonnet-4-6", TENANT)).toContain(
      "openai",
    );
    expect(modelSettingMismatch(revision, ["llm", "model"], "gpt-4.1", TENANT)).toBeNull();
  });

  test("ignores settings that are not model leaves", () => {
    expect(modelSettingMismatch(revision, ["llm", "provider"], "anthropic")).toBeNull();
  });
});
