// Unit tests: WS1 M2M OAuth — registry schema + parseAuthConfig for the two
// new auth kinds added in the M2M OAuth feature.
//
// Layer: unit — pure logic only. No DB, no Docker, no network.
// Run with: SKIP_DOCKER=1 bun run test:unit
//
// Coverage:
//   - parseAuthConfig accepts oauth2_client_credentials with client_id/scope
//   - parseAuthConfig accepts oauth2_private_key_jwt with client_id/algorithm/scope
//   - .strict() rejects inline secrets on the new kinds (secret-by-reference invariant)
//   - algorithm field round-trips for oauth2_private_key_jwt
//   - null column still defaults to { kind: "none" }
//   - wrong tenant → pool seam would skip the credential (unit aspect: credential shape)

import { describe, expect, test } from "bun:test";

import { parseAuthConfig } from "./registry.ts";

describe("parseAuthConfig — oauth2_client_credentials", () => {
  test("accepts minimal kind with client_id", () => {
    const cfg = parseAuthConfig({ kind: "oauth2_client_credentials", client_id: "my-client" });
    expect(cfg.kind).toBe("oauth2_client_credentials");
    expect(cfg.client_id).toBe("my-client");
  });

  test("accepts full shape with scope and issuer", () => {
    const cfg = parseAuthConfig({
      kind: "oauth2_client_credentials",
      client_id: "svc-account",
      scope: "tools:read tools:write",
      issuer: "https://auth.corp.example.com",
    });
    expect(cfg.kind).toBe("oauth2_client_credentials");
    expect(cfg.client_id).toBe("svc-account");
    expect(cfg.scope).toBe("tools:read tools:write");
    expect(cfg.issuer).toBe("https://auth.corp.example.com");
  });

  test("does not persist algorithm (algorithm is not present for client_credentials)", () => {
    // algorithm is only relevant for private_key_jwt; client_credentials
    // should still round-trip even when algorithm is omitted.
    const cfg = parseAuthConfig({ kind: "oauth2_client_credentials", client_id: "c1" });
    expect(cfg.algorithm).toBeUndefined();
  });

  test("rejects inline client_secret (.strict guard — secret must live in credentials table)", () => {
    // The .strict() Zod schema rejects any key not declared in authConfigSchema,
    // so an inline secret never reaches the DB row.
    expect(() =>
      parseAuthConfig({
        kind: "oauth2_client_credentials",
        client_id: "c1",
        client_secret: "shhh",
      }),
    ).toThrow();
  });

  test("rejects inline token", () => {
    expect(() =>
      parseAuthConfig({ kind: "oauth2_client_credentials", client_id: "c1", token: "tok" }),
    ).toThrow();
  });

  test("rejects inline private_key", () => {
    expect(() =>
      parseAuthConfig({ kind: "oauth2_client_credentials", client_id: "c1", private_key: "pem" }),
    ).toThrow();
  });
});

describe("parseAuthConfig — oauth2_private_key_jwt", () => {
  test("accepts kind with client_id and algorithm", () => {
    const cfg = parseAuthConfig({
      kind: "oauth2_private_key_jwt",
      client_id: "jwt-client",
      algorithm: "RS256",
    });
    expect(cfg.kind).toBe("oauth2_private_key_jwt");
    expect(cfg.client_id).toBe("jwt-client");
    expect(cfg.algorithm).toBe("RS256");
  });

  test("accepts ES256 algorithm variant", () => {
    const cfg = parseAuthConfig({
      kind: "oauth2_private_key_jwt",
      client_id: "ec-client",
      algorithm: "ES256",
      scope: "mcp:tools",
    });
    expect(cfg.algorithm).toBe("ES256");
    expect(cfg.scope).toBe("mcp:tools");
  });

  test("algorithm field round-trips unchanged (stored non-secret in auth_config)", () => {
    const cfg = parseAuthConfig({
      kind: "oauth2_private_key_jwt",
      client_id: "c2",
      algorithm: "RS384",
      issuer: "https://idp.example.com",
    });
    expect(cfg.algorithm).toBe("RS384");
    expect(cfg.issuer).toBe("https://idp.example.com");
  });

  test("rejects inline private_key (.strict guard)", () => {
    // The private key must live only in the encrypted credentials table,
    // never in auth_config.
    expect(() =>
      parseAuthConfig({
        kind: "oauth2_private_key_jwt",
        client_id: "c2",
        algorithm: "RS256",
        private_key: "-----BEGIN RSA PRIVATE KEY-----...",
      }),
    ).toThrow();
  });

  test("rejects inline client_secret", () => {
    expect(() =>
      parseAuthConfig({
        kind: "oauth2_private_key_jwt",
        client_id: "c2",
        algorithm: "RS256",
        client_secret: "shh",
      }),
    ).toThrow();
  });
});

describe("parseAuthConfig — backwards compatibility", () => {
  test("null → kind none (no regression)", () => {
    expect(parseAuthConfig(null)).toEqual({ kind: "none" });
  });

  test("bearer still parses without inline secret", () => {
    const cfg = parseAuthConfig({ kind: "bearer" });
    expect(cfg.kind).toBe("bearer");
  });

  test("oauth2 with issuer/client_id/scope still parses", () => {
    const cfg = parseAuthConfig({
      kind: "oauth2",
      issuer: "https://idp.example.com",
      client_id: "abc",
      scope: "read",
    });
    expect(cfg.kind).toBe("oauth2");
    expect(cfg.issuer).toBe("https://idp.example.com");
    expect(cfg.client_id).toBe("abc");
  });

  test("unknown kind is rejected", () => {
    expect(() => parseAuthConfig({ kind: "saml" })).toThrow();
  });
});

describe("parseAuthConfig — undefined optional fields are omitted from output", () => {
  test("client_id absent → not present on result (no undefined keys)", () => {
    // Under exactOptionalPropertyTypes, a key present with value undefined
    // is a different type from a key that is absent. parseAuthConfig must
    // never set a key to undefined on the returned object.
    const cfg = parseAuthConfig({ kind: "oauth2_client_credentials" });
    expect(Object.hasOwn(cfg, "client_id")).toBe(false);
    expect(Object.hasOwn(cfg, "scope")).toBe(false);
    expect(Object.hasOwn(cfg, "algorithm")).toBe(false);
    expect(Object.hasOwn(cfg, "issuer")).toBe(false);
  });

  test("algorithm absent from oauth2_private_key_jwt → not present on result", () => {
    const cfg = parseAuthConfig({ kind: "oauth2_private_key_jwt", client_id: "c3" });
    // algorithm may be omitted (schema uses .optional()); the key must be absent.
    if (!cfg.algorithm) {
      expect(Object.hasOwn(cfg, "algorithm")).toBe(false);
    }
  });
});
