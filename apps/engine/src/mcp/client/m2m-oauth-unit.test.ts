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
    const cfg = parseAuthConfig({ kind: "oauth2_client_credentials", client_id: "c1" });
    expect(cfg.algorithm).toBeUndefined();
  });

  test("rejects inline client_secret (.strict guard — secret must live in credentials table)", () => {
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
    const cfg = parseAuthConfig({ kind: "oauth2_client_credentials" });
    expect(Object.hasOwn(cfg, "client_id")).toBe(false);
    expect(Object.hasOwn(cfg, "scope")).toBe(false);
    expect(Object.hasOwn(cfg, "algorithm")).toBe(false);
    expect(Object.hasOwn(cfg, "issuer")).toBe(false);
  });

  test("algorithm absent from oauth2_private_key_jwt → not present on result", () => {
    const cfg = parseAuthConfig({ kind: "oauth2_private_key_jwt", client_id: "c3" });
    if (!cfg.algorithm) {
      expect(Object.hasOwn(cfg, "algorithm")).toBe(false);
    }
  });
});
