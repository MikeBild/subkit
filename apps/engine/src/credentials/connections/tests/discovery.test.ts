import { describe, expect, test } from "bun:test";
import { normalizeBaseUrl, requireConnectable } from "../discovery.ts";
import {
  type AuthorizationServerMetadata,
  ConnectionError,
  type ConnectionFailureCode,
} from "../types.ts";

describe("normalizeBaseUrl", () => {
  test("keeps origin and path, drops the trailing slash and credentials", () => {
    expect(normalizeBaseUrl(" https://wiki.example.com/ ")).toBe("https://wiki.example.com");
    expect(normalizeBaseUrl("https://user:pw@wiki.example.com/api/")).toBe(
      "https://wiki.example.com/api",
    );
  });

  test("allows plain http only for localhost", () => {
    expect(normalizeBaseUrl("http://localhost:4000/")).toBe("http://localhost:4000");
    expect(normalizeBaseUrl("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(() => normalizeBaseUrl("http://wiki.example.com")).toThrow(ConnectionError);
  });

  test.each(["not a url", "ftp://x", "https://x/?a=1", "https://x/#frag", ""])(
    "refuses %s",
    (input) => {
      expect(() => normalizeBaseUrl(input)).toThrow(ConnectionError);
    },
  );
});

describe("requireConnectable", () => {
  const metadata: AuthorizationServerMetadata = {
    issuer: "https://s.example",
    authorization_endpoint: "https://s.example/authorize",
    token_endpoint: "https://s.example/token",
    registration_endpoint: "https://s.example/register",
  };

  test("passes a server with registration and S256", () => {
    expect(
      requireConnectable({
        base_url: "https://s.example",
        authorization: metadata,
        descriptor: null,
      }).registration_endpoint,
    ).toBe("https://s.example/register");
  });

  test.each<[AuthorizationServerMetadata, ConnectionFailureCode]>([
    [{ ...metadata, registration_endpoint: undefined }, "registration_missing"],
    [{ ...metadata, code_challenge_methods_supported: ["plain"] }, "pkce_unsupported"],
  ])("names why a server cannot be connected: %o → %s", (authorization, code) => {
    try {
      requireConnectable({ base_url: "https://s.example", authorization, descriptor: null });
      throw new Error("expected a ConnectionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as ConnectionError).code).toBe(code);
    }
  });

  test("a server without metadata is discovery_missing", () => {
    expect(() =>
      requireConnectable({ base_url: "https://s.example", authorization: null, descriptor: null }),
    ).toThrow(/publishes no authorization-server metadata/);
  });
});
