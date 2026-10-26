import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import {
  engineUrlFromConfig,
  renderRuntimeContextBlock,
  resolveEngineUrl,
} from "../runtime-context.ts";

describe("renderRuntimeContextBlock", () => {
  it("returns null when no fields are set (no empty header burns cache space)", () => {
    expect(renderRuntimeContextBlock({})).toBeNull();
  });

  it("renders engine_url verbatim and forbids placeholder hosts", () => {
    const block = renderRuntimeContextBlock({ engine_url: "https://subkit-api.example.com" });
    expect(block).toContain("- engine_url: https://subkit-api.example.com");
    expect(block).toContain("never paraphrase");
    expect(block).toContain("your-subkit-instance.com");
    expect(block).toContain("cannot_help");
  });

  it("includes tenant_slug, actor_email, actor_role and surface when present", () => {
    const block = renderRuntimeContextBlock({
      engine_url: "https://e",
      tenant_slug: "acme",
      actor_email: "mike@example.com",
      actor_role: "operator",
      surface: "web",
    });
    expect(block).toContain("- tenant_slug: acme");
    expect(block).toContain("- actor_email: mike@example.com");
    expect(block).toContain("- actor_role: operator");
    expect(block).toContain("- surface: web");
  });

  it("omits absent optional fields (no `undefined` lines)", () => {
    const block = renderRuntimeContextBlock({ engine_url: "https://e", tenant_slug: "acme" });
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("- actor_email:");
    expect(block).not.toContain("- actor_role:");
  });

  it("drops the cannot_help fallback only when engine_url is present", () => {
    const block = renderRuntimeContextBlock({ engine_url: "https://e" });
    expect(block).toContain("cannot_help");
  });
});

describe("resolveEngineUrl", () => {
  it("returns the request's origin when present", () => {
    const url = resolveEngineUrl({ url: "https://subkit-api.example.com/v1/conversations" });
    expect(url).toBe("https://subkit-api.example.com");
  });

  it("strips path, query and hash", () => {
    const url = resolveEngineUrl({
      url: "https://host:8443/foo/bar?x=1#frag",
    });
    expect(url).toBe("https://host:8443");
  });

  it("does not use a retired env value on a malformed url", () => {
    const prev = process.env.SUBKIT_PUBLIC_BASE_URL;
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://from-env.example";
    try {
      const url = resolveEngineUrl({ url: "not a url" });
      expect(url).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SUBKIT_PUBLIC_BASE_URL;
      else process.env.SUBKIT_PUBLIC_BASE_URL = prev;
    }
  });

  it("returns undefined when both the request and canonical config are unusable", () => {
    const prev = process.env.SUBKIT_PUBLIC_BASE_URL;
    delete process.env.SUBKIT_PUBLIC_BASE_URL;
    try {
      const url = resolveEngineUrl({ url: "" });
      expect(url).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.SUBKIT_PUBLIC_BASE_URL = prev;
    }
  });
});

describe("resolveEngineUrl with a configured public base URL", () => {
  let configDirectory: string;

  beforeAll(async () => {
    configDirectory = mkdtempSync(join(tmpdir(), "runtime-context-"));
    _resetConfigForTests();
    await loadConfig({
      configPathOverride: join(configDirectory, "subkit.config.json"),
      env: { DATABASE_URL: "postgres://localhost/runtime_context_fixture", NODE_ENV: "test" },
    });
  });

  afterEach(async () => {
    await setConfigKey("server.public_base_url", "", { force: true });
  });

  afterAll(() => {
    _resetConfigForTests();
    rmSync(configDirectory, { recursive: true, force: true });
  });

  it("prefers the public base URL over a proxied plain-http request origin", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example.test", { force: true });
    expect(resolveEngineUrl({ url: "http://engine.example.test/v1/conversations" })).toBe(
      "https://engine.example.test",
    );
  });

  it("strips trailing slashes from the configured public base URL", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example.test/", { force: true });
    expect(engineUrlFromConfig()).toBe("https://engine.example.test");
    expect(resolveEngineUrl({ url: "not a url" })).toBe("https://engine.example.test");
  });

  it("falls back to the request origin without a public base URL", () => {
    expect(resolveEngineUrl({ url: "http://127.0.0.1:3000/v1/conversations" })).toBe(
      "http://127.0.0.1:3000",
    );
  });
});
