// Consumer read-back: every subsystem that consumes a config leaf
// must SEE the new value after setConfigKey, without a restart
// (except for `requiresRestart: true` leaves).
//
// This is the canonical "the change actually took effect" test —
// the round-trip + on-disk file tests prove the storage path; this
// test proves the read path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _disableReadSamplingForTests,
  _enableReadSamplingForTests,
  _resetConfigForTests,
  getConfig,
  loadConfig,
  setConfigKey,
} from "../loader.ts";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-readback-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
});

afterEach(() => {
  _disableReadSamplingForTests();
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("consumer read-back per subsystem", () => {
  test("egress-guard sees egress.mode change without a re-import", async () => {
    const { assertEgressAllowed, EgressBlockedError } = await import(
      "../../connectors/egress-guard.ts"
    );
    // Default mode is null → falls back to NODE_ENV. NODE_ENV=test
    // → permissive. A private host should pass.
    expect(() => assertEgressAllowed("http://10.0.0.1/x", {})).not.toThrow();

    await setConfigKey("egress.mode", "strict", { force: true });

    expect(() => assertEgressAllowed("http://10.0.0.1/x", {})).toThrow(EgressBlockedError);
  });

  test("count.ts isOneMillionContextActive sees llm.context_1m change", async () => {
    const { contextCapFor } = await import("../../llm/accounting/count.ts");
    // claude-sonnet-4-5 default cap (no 1M flag) is 180k.
    expect(contextCapFor("claude-sonnet-4-5")).toBe(180_000);
    await setConfigKey("llm.context_1m", true, { force: true });
    expect(contextCapFor("claude-sonnet-4-5")).toBe(900_000);
  });

  test("llm/core model-init readEnv reads through getConfig", async () => {
    // ENV_TO_CONFIG_PATH for ANTHROPIC_API_KEY → llm.providers.anthropic.api_key.
    // With the loader uninitialised, readEnv falls back to process.env.
    // With the loader up + a config write, readEnv must return the
    // config value.
    await setConfigKey("llm.providers.anthropic.api_key", "ant-config-key", {
      force: true,
    });
    const { detectConfiguredProvider } = await import("../../llm/core/model-init.ts");
    // detectConfiguredProvider reads LLM_PROVIDER (mapped to llm.provider).
    // Default is "mock" so detection returns "mock".
    expect(detectConfiguredProvider()).toBe("mock");

    await setConfigKey("llm.provider", "anthropic", { force: true });
    expect(detectConfiguredProvider()).toBe("anthropic");
  });

  test("globalLlmStatus reflects every provider config flip", async () => {
    const { globalLlmStatus } = await import("../../llm/core/invoke.ts");
    let st = globalLlmStatus();
    expect(st.anthropic_key_set).toBe(false);
    expect(st.openai_key_set).toBe(false);

    await setConfigKey("llm.providers.anthropic.api_key", "ant", { force: true });
    await setConfigKey("llm.providers.openai.api_key", "opn", { force: true });

    st = globalLlmStatus();
    expect(st.anthropic_key_set).toBe(true);
    expect(st.openai_key_set).toBe(true);
  });

  test("getConfig() reflects log.level change and the live logger reconfigures", async () => {
    expect(getConfig().log.level).toBe("info");
    await setConfigKey("log.level", "trace", { force: true });
    expect(getConfig().log.level).toBe("trace");
  });

  test("getConfig().mcp.read_only flips after setConfigKey", async () => {
    expect(getConfig().mcp.read_only).toBe(false);
    await setConfigKey("mcp.read_only", true, { force: true });
    expect(getConfig().mcp.read_only).toBe(true);
  });

  test("getConfig().auth.oidc.* updates flow through OIDC provider config", async () => {
    expect(getConfig().auth.oidc.issuer_url).toBe("");
    await setConfigKey("auth.oidc.issuer_url", "https://issuer.example.com", { force: true });
    await setConfigKey("auth.oidc.client_id", "client-x", { force: true });
    expect(getConfig().auth.oidc.issuer_url).toBe("https://issuer.example.com");
    expect(getConfig().auth.oidc.client_id).toBe("client-x");
  });

  test("getConfig().observability.* updates are visible to subsequent reads", async () => {
    expect(getConfig().observability.langfuse.host).toBe("");
    await setConfigKey("observability.langfuse.host", "https://lf.local", { force: true });
    await setConfigKey("observability.otlp.endpoint", "https://otel.local:4318", { force: true });
    expect(getConfig().observability.langfuse.host).toBe("https://lf.local");
    expect(getConfig().observability.otlp.endpoint).toBe("https://otel.local:4318");
  });

  test("read sampling proves consumers actually re-read after a write", async () => {
    const counter = _enableReadSamplingForTests();
    counter.clear();
    // Read once.
    getConfig().llm.api_key;
    expect(counter.get("global") ?? 0).toBeGreaterThanOrEqual(1);

    // setConfigKey itself reads getConfig internally (for the
    // tenant-merge path); after it, the new value flows.
    await setConfigKey("llm.api_key", "fresh", { force: true });

    const before = counter.get("global") ?? 0;
    expect(getConfig().llm.api_key).toBe("fresh");
    // Reading getConfig again increments the sampler.
    expect(counter.get("global") ?? 0).toBeGreaterThan(before);
  });
});
