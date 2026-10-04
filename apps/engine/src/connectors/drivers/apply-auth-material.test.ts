import { describe, expect, test } from "bun:test";
import type { ConnectorView } from "../types.ts";
import { applyAuthMaterial } from "./http.ts";

function makeOauth2Connector(): ConnectorView {
  return {
    id: "00000000-0000-0000-0000-000000000099",
    tenant_id: "tenant-test",
    slug: "test-oauth2",
    driver: "http",
    environment: "dev",
    auth_type: "oauth2",
    base_url: "https://api.example.test",
    config: {},
    template_slug: null,
    template_snapshot: null,
  } as unknown as ConnectorView;
}

describe("applyAuthMaterial — oauth2 token_type case normalization", () => {
  test("token_type='Bearer' produces standard Bearer prefix", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "tok-1",
        token_type: "Bearer",
        refresh_token: null,
        expires_at: null,
      },
      headers,
      {},
    );
    expect(headers.Authorization).toBe("Bearer tok-1");
  });

  test("token_type='bearer' (Google's lowercase) canonicalises to 'Bearer'", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "ya29.a0AQv",
        token_type: "bearer",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("Bearer ya29.a0AQv");
  });

  test("token_type='BEARER' (uppercase) also canonicalises to 'Bearer'", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "abc",
        token_type: "BEARER",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("Bearer abc");
  });

  test("token_type='' emits raw token (AppSync Cognito User-Pool flow)", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "raw-jwt",
        token_type: "",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("raw-jwt");
  });

  test("token_type='none' (explicit opt-out) emits raw token", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "id-token",
        token_type: "none",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("id-token");
  });

  test("custom non-Bearer scheme (e.g. 'Token' for GitLab PAT) is preserved verbatim", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "glpat-xyz",
        token_type: "Token",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBe("Token glpat-xyz");
  });
});

describe("applyAuthMaterial — oauth2 empty access_token guard (empty-Bearer regression)", () => {
  test("empty access_token → NO Authorization header emitted", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "",
        token_type: "Bearer",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBeUndefined();
  });

  test("null access_token → NO Authorization header emitted", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        // biome-ignore lint/suspicious/noExplicitAny: testing null access_token at runtime boundary
        access_token: null as any,
        token_type: "Bearer",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBeUndefined();
  });

  test("non-empty access_token → Authorization: Bearer <token> (positive path)", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "live-token-abc123",
        token_type: "Bearer",
        refresh_token: null,
        expires_at: null,
      },
      headers,
      {},
    );
    expect(headers.Authorization).toBe("Bearer live-token-abc123");
  });

  test("empty access_token with no_prefix token_type → still NO header (empty wins over scheme)", () => {
    const headers: Record<string, string> = {};
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "",
        token_type: "no_prefix",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBeUndefined();
  });

  test("pre-existing headers are preserved when access_token is empty", () => {
    const headers: Record<string, string> = { "x-request-id": "req-42" };
    applyAuthMaterial(
      makeOauth2Connector(),
      {
        mode: "oauth2",
        access_token: "",
        token_type: "Bearer",
        refresh_token: null,
        expires_at: null,
      } as never,
      headers,
      {},
    );
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-request-id"]).toBe("req-42");
  });
});
