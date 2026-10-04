import { describe, expect, test } from "bun:test";
import { recognizeAuthFromSchemes } from "./recognize-auth.ts";
import type { DiscoveredAuthScheme } from "./types.ts";

describe("recognizeAuthFromSchemes — apiKey + http arms", () => {
  test("apiKey in header → header", () => {
    const schemes: DiscoveredAuthScheme[] = [
      { name: "ApiKeyAuth", type: "apiKey", location: "header" },
    ];
    expect(recognizeAuthFromSchemes(schemes)).toEqual({
      auth_type: "header",
      scheme_name: "ApiKeyAuth",
    });
  });

  test("apiKey in query → query", () => {
    const schemes: DiscoveredAuthScheme[] = [
      { name: "QueryKey", type: "apiKey", location: "query" },
    ];
    expect(recognizeAuthFromSchemes(schemes)).toEqual({
      auth_type: "query",
      scheme_name: "QueryKey",
    });
  });

  test("apiKey in cookie → not usable (null)", () => {
    const schemes: DiscoveredAuthScheme[] = [
      { name: "CookieKey", type: "apiKey", location: "cookie" },
    ];
    expect(recognizeAuthFromSchemes(schemes)).toBeNull();
  });

  test("http bearer → bearer (scheme is case-insensitive)", () => {
    const schemes: DiscoveredAuthScheme[] = [
      { name: "BearerAuth", type: "http", scheme: "Bearer" },
    ];
    expect(recognizeAuthFromSchemes(schemes)).toEqual({
      auth_type: "bearer",
      scheme_name: "BearerAuth",
    });
  });

  test("http basic → basic", () => {
    const schemes: DiscoveredAuthScheme[] = [{ name: "BasicAuth", type: "http", scheme: "basic" }];
    expect(recognizeAuthFromSchemes(schemes)).toEqual({
      auth_type: "basic",
      scheme_name: "BasicAuth",
    });
  });

  test("http with an unknown scheme (digest) → null", () => {
    const schemes: DiscoveredAuthScheme[] = [
      { name: "DigestAuth", type: "http", scheme: "digest" },
    ];
    expect(recognizeAuthFromSchemes(schemes)).toBeNull();
  });
});

describe("recognizeAuthFromSchemes — oauth2 arm", () => {
  test("oauth2 authorizationCode flow → oauth2 + endpoints + space-joined scope", () => {
    const schemes: DiscoveredAuthScheme[] = [
      {
        name: "oauth2",
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorization_url: "https://id.example.com/authorize",
            token_url: "https://id.example.com/token",
            scopes: { "read:data": "Read", "write:data": "Write" },
          },
        },
      },
    ];
    expect(recognizeAuthFromSchemes(schemes)).toEqual({
      auth_type: "oauth2",
      scheme_name: "oauth2",
      oauth: {
        authorization_endpoint: "https://id.example.com/authorize",
        token_endpoint: "https://id.example.com/token",
        scope: "read:data write:data",
        grant_type: "authorization_code",
      },
    });
  });

  test("oauth2 with only clientCredentials → grant_type client_credentials", () => {
    const schemes: DiscoveredAuthScheme[] = [
      {
        name: "oauth2",
        type: "oauth2",
        flows: {
          clientCredentials: {
            token_url: "https://id.example.com/token",
            scopes: {},
          },
        },
      },
    ];
    const r = recognizeAuthFromSchemes(schemes);
    expect(r?.auth_type).toBe("oauth2");
    expect(r?.oauth?.grant_type).toBe("client_credentials");
    expect(r?.oauth?.token_endpoint).toBe("https://id.example.com/token");
    expect(r?.oauth?.authorization_endpoint).toBeUndefined();
  });

  test("flow preference: authorizationCode wins over clientCredentials", () => {
    const schemes: DiscoveredAuthScheme[] = [
      {
        name: "oauth2",
        type: "oauth2",
        flows: {
          clientCredentials: { token_url: "https://id.example.com/cc-token" },
          authorizationCode: {
            authorization_url: "https://id.example.com/authorize",
            token_url: "https://id.example.com/ac-token",
          },
        },
      },
    ];
    const r = recognizeAuthFromSchemes(schemes);
    expect(r?.oauth?.grant_type).toBe("authorization_code");
    expect(r?.oauth?.token_endpoint).toBe("https://id.example.com/ac-token");
  });

  test("implicit flow maps to authorization_code grant", () => {
    const schemes: DiscoveredAuthScheme[] = [
      {
        name: "oauth2",
        type: "oauth2",
        flows: {
          implicit: { authorization_url: "https://id.example.com/authorize" },
        },
      },
    ];
    expect(recognizeAuthFromSchemes(schemes)?.oauth?.grant_type).toBe("authorization_code");
  });

  test("oauth2 with empty scopes → scope omitted", () => {
    const schemes: DiscoveredAuthScheme[] = [
      {
        name: "oauth2",
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorization_url: "https://id.example.com/authorize",
            token_url: "https://id.example.com/token",
            scopes: {},
          },
        },
      },
    ];
    expect(recognizeAuthFromSchemes(schemes)?.oauth?.scope).toBeUndefined();
  });

  test("oauth2 without flows → auth_type oauth2 with NO oauth block", () => {
    const schemes: DiscoveredAuthScheme[] = [{ name: "oauth2", type: "oauth2" }];
    const r = recognizeAuthFromSchemes(schemes);
    expect(r).toEqual({ auth_type: "oauth2", scheme_name: "oauth2" });
    expect(r?.oauth).toBeUndefined();
  });

  test("openIdConnect without flows → oauth2 type, no oauth block", () => {
    const schemes: DiscoveredAuthScheme[] = [{ name: "oidc", type: "openIdConnect" }];
    const r = recognizeAuthFromSchemes(schemes);
    expect(r?.auth_type).toBe("oauth2");
    expect(r?.oauth).toBeUndefined();
  });
});

describe("recognizeAuthFromSchemes — precedence + edge cases", () => {
  test("oauth2 wins when both apiKey and oauth2 are declared", () => {
    const schemes: DiscoveredAuthScheme[] = [
      { name: "ApiKeyAuth", type: "apiKey", location: "header" },
      {
        name: "oauth2",
        type: "oauth2",
        flows: { authorizationCode: { token_url: "https://id.example.com/token" } },
      },
    ];
    expect(recognizeAuthFromSchemes(schemes)?.auth_type).toBe("oauth2");
  });

  test("http bearer wins over apiKey when no oauth2 present", () => {
    const schemes: DiscoveredAuthScheme[] = [
      { name: "ApiKeyAuth", type: "apiKey", location: "header" },
      { name: "BearerAuth", type: "http", scheme: "bearer" },
    ];
    expect(recognizeAuthFromSchemes(schemes)?.auth_type).toBe("bearer");
  });

  test("empty list → null", () => {
    expect(recognizeAuthFromSchemes([])).toBeNull();
  });

  test("only unrecognized schemes → null", () => {
    const schemes: DiscoveredAuthScheme[] = [
      { name: "mtls", type: "http", scheme: "mutual-tls" },
      { name: "weird", type: "apiKey", location: "cookie" },
    ];
    expect(recognizeAuthFromSchemes(schemes)).toBeNull();
  });
});
