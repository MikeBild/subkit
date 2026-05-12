// Tests for the canonical OAuth2 redirect URI synthesizer. The
// reference impl pattern (web/src/lib/oauth-utils.ts:37-40) is one
// callback URL per server — the engine MUST always return the same
// value regardless of which connector is authenticating. These tests
// pin that contract.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "./redirect-uri.ts";

const originalPublicBaseUrl = process.env.SUBKIT_PUBLIC_BASE_URL;

function makeReq(url: string, headers: Record<string, string> = {}) {
  return { url, headers: new Headers(headers) };
}

beforeEach(() => {
  delete process.env.SUBKIT_PUBLIC_BASE_URL;
});

afterEach(() => {
  if (originalPublicBaseUrl === undefined) {
    delete process.env.SUBKIT_PUBLIC_BASE_URL;
  } else {
    process.env.SUBKIT_PUBLIC_BASE_URL = originalPublicBaseUrl;
  }
});

describe("buildOAuthRedirectUri", () => {
  it("returns null when no source is configured", () => {
    expect(buildOAuthRedirectUri()).toBeNull();
  });

  it("uses SUBKIT_PUBLIC_BASE_URL env when no request is supplied", () => {
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://engine.example";
    expect(buildOAuthRedirectUri()).toBe("https://engine.example/v1/oauth/callback");
  });

  it("trims a trailing slash on the env fallback", () => {
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://engine.example/";
    expect(buildOAuthRedirectUri()).toBe("https://engine.example/v1/oauth/callback");
  });

  it("prefers SUBKIT_PUBLIC_BASE_URL over request origin (config is operator-canonical)", () => {
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://engine.example";
    const req = makeReq("https://other.example/anything");
    expect(buildOAuthRedirectUri({ req })).toBe("https://engine.example/v1/oauth/callback");
  });

  it("uses x-forwarded-host + x-forwarded-proto when env is unset", () => {
    const req = makeReq("http://localhost:3000/v1/connectors/abc/oauth/start", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "subkit-api.mikebild.dev",
    });
    expect(buildOAuthRedirectUri({ req })).toBe(
      "https://subkit-api.mikebild.dev/v1/oauth/callback",
    );
  });

  it("falls back to the host header when x-forwarded-host is missing", () => {
    const req = makeReq("https://subkit-api.mikebild.dev/v1/connectors/abc/oauth/start", {
      host: "subkit-api.mikebild.dev",
    });
    expect(buildOAuthRedirectUri({ req })).toBe(
      "https://subkit-api.mikebild.dev/v1/oauth/callback",
    );
  });

  it("falls back to req.url.origin as last resort", () => {
    const req = makeReq("https://subkit-api.mikebild.dev/v1/connectors/abc/oauth/start");
    expect(buildOAuthRedirectUri({ req })).toBe(
      "https://subkit-api.mikebild.dev/v1/oauth/callback",
    );
  });

  it("constant path = /v1/oauth/callback (one URL per engine, not per connector)", () => {
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://e.example";
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
