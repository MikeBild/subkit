import { describe, expect, test } from "bun:test";
import {
  discoverService,
  normalizeBaseUrl,
  requireConnectable,
  resolvePackageUrl,
} from "../discovery.ts";
import {
  type AuthorizationServerMetadata,
  ConnectionError,
  type ConnectionFailureCode,
  ServicePackageSchema,
} from "../types.ts";
import { startFakeOAuthServer } from "./fake-oauth-server.ts";

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
        package: null,
      }).registration_endpoint,
    ).toBe("https://s.example/register");
  });

  test.each<[AuthorizationServerMetadata, ConnectionFailureCode]>([
    [{ ...metadata, registration_endpoint: undefined }, "registration_missing"],
    [{ ...metadata, code_challenge_methods_supported: ["plain"] }, "pkce_unsupported"],
  ])("names why a server cannot be connected: %o → %s", (authorization, code) => {
    try {
      requireConnectable({
        base_url: "https://s.example",
        authorization,
        descriptor: null,
        package: null,
      });
      throw new Error("expected a ConnectionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as ConnectionError).code).toBe(code);
    }
  });

  test("a server without metadata is discovery_missing", () => {
    expect(() =>
      requireConnectable({
        base_url: "https://s.example",
        authorization: null,
        descriptor: null,
        package: null,
      }),
    ).toThrow(new ConnectionError("discovery_missing", "authorization_metadata_missing"));
  });
});

describe("resolvePackageUrl", () => {
  test("resolves a relative package link against the service path", () => {
    expect(resolvePackageUrl("https://support.example.com/support", "../package.json")).toBe(
      "https://support.example.com/support/package.json",
    );
  });

  test.each([
    "https://other.example.com/package.json",
    "https://user:secret@support.example.com/package.json",
    "javascript:alert(1)",
  ])("refuses an unsafe package link: %s", (href) => {
    expect(resolvePackageUrl("https://support.example.com/support", href)).toBeNull();
  });
});

test("service packages accept versioned, hash checked artifact metadata", () => {
  const valid = ServicePackageSchema.safeParse({
    format: "subkit.package/v1",
    id: "com.subkit.support",
    version: "1.1.0",
    name: "SubKit Support",
    artifacts: {
      skill: { href: "skill.md", sha256: "a".repeat(64) },
      workflows: { href: "workflows.json?connector_id={connector_id}" },
    },
    scripts: [{ command: "install arbitrary code" }],
  });
  expect(valid.success).toBe(true);
  if (valid.success) expect(valid.data).not.toHaveProperty("scripts");
  expect(
    ServicePackageSchema.safeParse({
      format: "subkit.package/v1",
      id: "com.subkit.support",
      version: "1.1.0",
      name: "SubKit Support",
      artifacts: { skill: { href: "skill.md", sha256: "not-a-hash" } },
    }).success,
  ).toBe(false);
});

test("service discovery fetches only the linked, same-origin package manifest", async () => {
  const service = await startFakeOAuthServer();
  try {
    const result = await discoverService(service.baseUrl, { mode: "permissive" });
    expect(result.package).toMatchObject({
      id: "com.subkit.support",
      version: "1.1.0",
      name: "SubKit Support",
    });
    expect(result.package).not.toHaveProperty("scripts");
    expect(service.requests).toContain("GET /package.json");
    service.redirectPackage = true;
    expect((await discoverService(service.baseUrl, { mode: "permissive" })).package).toBeNull();
    service.redirectPackage = false;
    service.oversizePackage = true;
    expect((await discoverService(service.baseUrl, { mode: "permissive" })).package).toBeNull();
  } finally {
    await service.close();
  }
});
