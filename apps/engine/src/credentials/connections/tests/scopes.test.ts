import { describe, expect, test } from "bun:test";
import { permissionScopes, requestedScopes } from "../scopes.ts";
import type { AuthorizationServerMetadata } from "../types.ts";

const base: AuthorizationServerMetadata = {
  issuer: "https://auth.test",
  authorization_endpoint: "https://auth.test/authorize",
  token_endpoint: "https://auth.test/token",
};

describe("requestedScopes", () => {
  test("adds offline_access when the server advertises it", () => {
    const metadata = { ...base, scopes_supported: ["read", "offline_access"] };
    expect(requestedScopes(["read"], metadata)).toEqual(["read", "offline_access"]);
  });

  test("adds it when the server also lists the refresh_token grant", () => {
    const metadata = {
      ...base,
      scopes_supported: ["offline_access"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    };
    expect(requestedScopes(["read"], metadata)).toEqual(["read", "offline_access"]);
  });

  test("does not add it when the server does not advertise it", () => {
    expect(requestedScopes(["read"], { ...base, scopes_supported: ["read"] })).toEqual(["read"]);
    expect(requestedScopes(["read"], base)).toEqual(["read"]);
  });

  test("does not add it when the server rules out the refresh_token grant", () => {
    const metadata = {
      ...base,
      scopes_supported: ["offline_access"],
      grant_types_supported: ["authorization_code"],
    };
    expect(requestedScopes(["read"], metadata)).toEqual(["read"]);
  });

  test("a person's offline_access is not passed on where the server has no use for it", () => {
    expect(requestedScopes(["read", "offline_access"], base)).toEqual(["read"]);
  });
});

describe("permissionScopes", () => {
  test("drops the protocol scope, blanks and duplicates, keeps the order", () => {
    expect(permissionScopes(["write", " offline_access", "", "read", "write"])).toEqual([
      "write",
      "read",
    ]);
  });
});
