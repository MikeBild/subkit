// One reading of an OAuth scope string. RFC 6749 separates scope tokens with
// spaces; an authorization server that answers with a comma-separated list
// granted the same set. Read with spaces alone, a comma list is one unknown
// token, every requested scope reads as missing, and a sign-in that granted
// everything is reported as a partial grant.

import { describe, expect, test } from "bun:test";
import { diffOauthScopes } from "../../connectors/oauth-scope-diff.ts";
import { normalizeScopeString, parseScopeList } from "../authority-scopes.ts";
import { grantedScopes } from "../connections/oauth-client.ts";
import { permissionScopes } from "../connections/scopes.ts";

describe("parseScopeList", () => {
  test("space-separated", () => {
    expect(parseScopeList("openid profile email")).toEqual(["openid", "profile", "email"]);
  });
  test("comma-separated", () => {
    expect(parseScopeList("email,openid,profile,write")).toEqual([
      "email",
      "openid",
      "profile",
      "write",
    ]);
  });
  test("mixed separators and surrounding blanks", () => {
    expect(parseScopeList(" read, write  admin,\tprofile ")).toEqual([
      "read",
      "write",
      "admin",
      "profile",
    ]);
  });
  test("empty and separator-only strings hold no scope", () => {
    expect(parseScopeList("")).toEqual([]);
    expect(parseScopeList("   ")).toEqual([]);
    expect(parseScopeList(" , ,")).toEqual([]);
  });
  test("duplicates are one scope, first position kept", () => {
    expect(parseScopeList("read write,read write")).toEqual(["read", "write"]);
  });
  test("scope tokens keep their case and their URL form", () => {
    expect(parseScopeList("Read https://api.example.test/auth/read")).toEqual([
      "Read",
      "https://api.example.test/auth/read",
    ]);
  });
});

describe("normalizeScopeString — the stored form", () => {
  test("joins the tokens with single spaces", () => {
    expect(normalizeScopeString("email,openid,profile")).toBe("email openid profile");
    expect(normalizeScopeString("read,  write read")).toBe("read write");
  });
  test("unknown stays unknown; an empty grant stays empty", () => {
    expect(normalizeScopeString(null)).toBeNull();
    expect(normalizeScopeString("")).toBe("");
    expect(normalizeScopeString(" , ")).toBe("");
  });
});

describe("diffOauthScopes over a comma-separated grant", () => {
  test("every requested scope granted in a comma list is not a partial grant", () => {
    const d = diffOauthScopes("openid profile email write", "email,openid,profile,write");
    expect(d).toMatchObject({
      partial_grant: false,
      expected: ["openid", "profile", "email", "write"],
      granted: ["email", "openid", "profile", "write"],
      missing: [],
    });
  });
  test("a comma list that lacks a requested scope names exactly that one", () => {
    const d = diffOauthScopes("openid profile email write", "email,openid,profile");
    expect(d?.partial_grant).toBe(true);
    expect(d?.missing).toEqual(["write"]);
  });
  test("a comma-separated request is read the same way", () => {
    expect(diffOauthScopes("read,write", "write read")?.partial_grant).toBe(false);
  });
  test("mixed separators and duplicates", () => {
    const d = diffOauthScopes("read write read", "write, read,read");
    expect(d).toMatchObject({ partial_grant: false, expected: ["read", "write"], missing: [] });
  });
  test("a grant string without a scope token is read like the stored form: unknown", () => {
    expect(diffOauthScopes("read", "")?.partial_grant).toBe("unknown");
    expect(diffOauthScopes("read", " , ")?.partial_grant).toBe("unknown");
  });
});

describe("outbound connections read a grant the same way", () => {
  test("a token response with a comma list", () => {
    expect(grantedScopes({ access_token: "t", token_type: "Bearer", scope: "read,write" })).toEqual(
      ["read", "write"],
    );
  });
  test("a stored entry holding a whole comma list is split", () => {
    expect(permissionScopes(["read,write offline_access", "read"])).toEqual(["read", "write"]);
  });
});
