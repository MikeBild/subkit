// Tests for the canonical OAuth2 redirect URI synthesizer. The engine
// MUST always return the same value regardless of which connector is
// authenticating — one callback URL per server. These tests pin that
// contract + the resolution precedence
// (config → x-forwarded-* → host → req.url).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "./redirect-uri.ts";

function makeReq(url: string, headers: Record<string, string> = {}) {
  return { url, headers: new Headers(headers) };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-redirect-uri-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/redirect-uri-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
});

afterAll(() => {
  _resetConfigForTests();
});

beforeEach(async () => {
  await setConfigKey("server.public_base_url", "", { force: true });
});

afterEach(async () => {
  await setConfigKey("server.public_base_url", "", { force: true });
});

describe("buildOAuthRedirectUri", () => {
  it("returns null when no source is configured", () => {
    expect(buildOAuthRedirectUri()).toBeNull();
  });

  it("uses server.public_base_url when no request is supplied", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    expect(buildOAuthRedirectUri()).toBe("https://engine.example/v1/oauth/callback");
  });

  it("trims a trailing slash on the configured base", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example/", { force: true });
    expect(buildOAuthRedirectUri()).toBe("https://engine.example/v1/oauth/callback");
  });

  it("prefers server.public_base_url over request origin (config is operator-canonical)", async () => {
    await setConfigKey("server.public_base_url", "https://engine.example", { force: true });
    const req = makeReq("https://other.example/anything");
    expect(buildOAuthRedirectUri({ req })).toBe("https://engine.example/v1/oauth/callback");
  });

  it("uses x-forwarded-host + x-forwarded-proto when config is unset", () => {
    const req = makeReq("http://localhost:3000/v1/connectors/abc/oauth/start", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "subkit-api.example.com",
    });
    expect(buildOAuthRedirectUri({ req })).toBe("https://subkit-api.example.com/v1/oauth/callback");
  });

  it("falls back to the host header when x-forwarded-host is missing", () => {
    const req = makeReq("https://subkit-api.example.com/v1/connectors/abc/oauth/start", {
      host: "subkit-api.example.com",
    });
    expect(buildOAuthRedirectUri({ req })).toBe("https://subkit-api.example.com/v1/oauth/callback");
  });

  it("falls back to req.url.origin as last resort", () => {
    const req = makeReq("https://subkit-api.example.com/v1/connectors/abc/oauth/start");
    expect(buildOAuthRedirectUri({ req })).toBe("https://subkit-api.example.com/v1/oauth/callback");
  });

  it("constant path = /v1/oauth/callback (one URL per engine, not per connector)", async () => {
    await setConfigKey("server.public_base_url", "https://e.example", { force: true });
    expect(OAUTH_CALLBACK_PATH).toBe("/v1/oauth/callback");
    const a = buildOAuthRedirectUri({
      req: makeReq("https://e.example/v1/connectors/aaa/oauth/start"),
    });
    const b = buildOAuthRedirectUri({
      req: makeReq("https://e.example/v1/connectors/bbb/oauth/start"),
    });
    expect(a).toBe(b);
  });
});
