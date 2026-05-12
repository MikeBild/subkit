// Tests for the canonical OAuth2 redirect URI synthesizer. The
// reference impl pattern (web/src/lib/oauth-utils.ts:37-40) is one
// callback URL per server — the engine MUST always return the same
// value regardless of which connector is authenticating. These tests
// pin that contract.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "./redirect-uri.ts";

const originalPublicBaseUrl = process.env.SUBKIT_PUBLIC_BASE_URL;

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

  it("uses the live request origin when present", () => {
    const req = { url: "https://subkit-api.mikebild.dev/v1/connectors/abc/oauth/start" };
    expect(buildOAuthRedirectUri(req)).toBe("https://subkit-api.mikebild.dev/v1/oauth/callback");
  });

  it("falls back to SUBKIT_PUBLIC_BASE_URL env when no request is supplied", () => {
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://engine.example";
    expect(buildOAuthRedirectUri()).toBe("https://engine.example/v1/oauth/callback");
  });

  it("trims a trailing slash on the env fallback", () => {
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://engine.example/";
    expect(buildOAuthRedirectUri()).toBe("https://engine.example/v1/oauth/callback");
  });

  it("prefers the request origin over env when both are set", () => {
    process.env.SUBKIT_PUBLIC_BASE_URL = "https://wrong.example";
    const req = { url: "https://right.example/anything" };
    expect(buildOAuthRedirectUri(req)).toBe("https://right.example/v1/oauth/callback");
  });

  it("uses HTTPS scheme verbatim from the live origin (no downgrade)", () => {
    const req = { url: "https://subkit-api.mikebild.dev/v1/oauth/start" };
    expect(buildOAuthRedirectUri(req)).toMatch(/^https:\/\//);
  });

  it("constant path = /v1/oauth/callback (one URL per engine, not per connector)", () => {
    expect(OAUTH_CALLBACK_PATH).toBe("/v1/oauth/callback");
    const a = buildOAuthRedirectUri({ url: "https://e.example/v1/connectors/aaa/oauth/start" });
    const b = buildOAuthRedirectUri({ url: "https://e.example/v1/connectors/bbb/oauth/start" });
    expect(a).toBe(b);
  });
});
