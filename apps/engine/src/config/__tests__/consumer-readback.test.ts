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

  test("egress-guard inverse: permissive mode allows what strict blocks", async () => {
    const { assertEgressAllowed, EgressBlockedError } = await import(
      "../../connectors/egress-guard.ts"
    );
    // Pre-condition: flip to strict so the private host is currently blocked.
    await setConfigKey("egress.mode", "strict", { force: true });
    expect(() => assertEgressAllowed("http://10.0.0.2/y", {})).toThrow(EgressBlockedError);

    // Flip back to permissive — the same host must now pass without
    // a re-import or any module reset. Proves the read path is live.
    await setConfigKey("egress.mode", "permissive", { force: true });
    expect(() => assertEgressAllowed("http://10.0.0.2/y", {})).not.toThrow();
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

  test("bedrock_key_set requires region + access_key_id + secret_access_key", async () => {
    // Multi-leaf invariant: bedrock is "configured" only when ALL three
    // related leaves are populated. Any single missing leaf must render
    // bedrock_key_set=false. Catches drift if the predicate ever
    // collapses to "any of" in invoke.ts.
    const { globalLlmStatus } = await import("../../llm/core/invoke.ts");
    expect(globalLlmStatus().bedrock_key_set).toBe(false);

    await setConfigKey("llm.providers.bedrock.access_key_id", "AKIA...", { force: true });
    expect(globalLlmStatus().bedrock_key_set).toBe(false);

    await setConfigKey("llm.providers.bedrock.secret_access_key", "secret-bytes", { force: true });
    expect(globalLlmStatus().bedrock_key_set).toBe(false);

    await setConfigKey("llm.providers.bedrock.region", "us-east-1", { force: true });
    expect(globalLlmStatus().bedrock_key_set).toBe(true);

    // Drop one leaf — flips back to false. Proves the predicate is
    // sensitive to each leaf, not just first-set-wins.
    await setConfigKey("llm.providers.bedrock.region", "", { force: true });
    expect(globalLlmStatus().bedrock_key_set).toBe(false);
  });

  test("getConfig() reflects log.level change and the live logger reconfigures", async () => {
    expect(getConfig().log.level).toBe("info");
    await setConfigKey("log.level", "trace", { force: true });
    expect(getConfig().log.level).toBe("trace");
  });

  test("setConfigKey log.level actually flips the live logger threshold", async () => {
    // Stronger than the previous test: prove the live `logger` object's
    // emit threshold actually reconfigured (not just the in-memory
    // Config). Capture stdout, force a known starting point, set
    // log.level via setConfigKey, then verify a debug line that was
    // suppressed before is emitted after.
    const { logger, reconfigureLogger } = await import("../../logging/logger.ts");
    reconfigureLogger({ level: "info", format: "ndjson" });
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      for (const line of s.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{")) lines.push(trimmed);
      }
      return orig(chunk);
    }) as typeof process.stdout.write;
    try {
      // Pre-condition: at info threshold, a debug line is suppressed.
      logger.debug({ module: "test", msg: "pre-debug-suppressed" });
      expect(lines.some((l) => l.includes("pre-debug-suppressed"))).toBe(false);

      await setConfigKey("log.level", "debug", { force: true });

      // Post-condition: after setConfigKey, debug emits flow without restart.
      logger.debug({ module: "test", msg: "post-debug-emitted" });
      expect(lines.some((l) => l.includes("post-debug-emitted"))).toBe(true);
    } finally {
      process.stdout.write = orig as typeof process.stdout.write;
      reconfigureLogger({ level: "info", format: "ndjson" });
    }
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

  test("offload resolver picks up storage.offload.* changes without restart", async () => {
    const { _s3OffloadConfigForTests } = await import("../../execution/offload.ts");
    // No bucket configured → resolver returns null (offload disabled).
    expect(_s3OffloadConfigForTests()).toBeNull();

    // Set the minimum required leaves: bucket + access keys.
    await setConfigKey("storage.offload.bucket", "test-bucket", { force: true });
    await setConfigKey("storage.offload.access_key", "ak", { force: true });
    await setConfigKey("storage.offload.secret_key", "sk", { force: true });
    await setConfigKey("storage.offload.region", "eu-central-1", { force: true });

    const cfg = _s3OffloadConfigForTests();
    expect(cfg).not.toBeNull();
    expect(cfg!.bucket).toBe("test-bucket");
    expect(cfg!.region).toBe("eu-central-1");
    expect(cfg!.accessKey).toBe("ak");
    expect(cfg!.secretKey).toBe("sk");
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
