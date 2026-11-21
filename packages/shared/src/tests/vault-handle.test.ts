import { describe, expect, test } from "bun:test";
import {
  containsSecretReference,
  formatVaultPlaceholder,
  isSecretName,
  isVaultItemName,
  parseSecretReference,
  parseVaultHandle,
  secretReference,
  vaultHandleKey,
  vaultItemNameFrom,
} from "../vault-handle.ts";

describe("isVaultItemName", () => {
  test("accepts lowercase names with digits, dashes and underscores", () => {
    expect(isVaultItemName("crm-token")).toBe(true);
    expect(isVaultItemName("a")).toBe(true);
    expect(isVaultItemName("9_x")).toBe(true);
    expect(isVaultItemName("a".repeat(63))).toBe(true);
  });

  test("refuses the person segment, capitals, dots, leading signs and long names", () => {
    expect(isVaultItemName("me")).toBe(false);
    expect(isVaultItemName("Crm")).toBe(false);
    expect(isVaultItemName("a.b")).toBe(false);
    expect(isVaultItemName("-a")).toBe(false);
    expect(isVaultItemName("_a")).toBe(false);
    expect(isVaultItemName("")).toBe(false);
    expect(isVaultItemName("a".repeat(64))).toBe(false);
    expect(isVaultItemName("x y")).toBe(false);
  });
});

describe("parseVaultHandle", () => {
  test("reads a workspace item", () => {
    expect(parseVaultHandle(["crm-token"])).toEqual({
      scope: "workspace",
      name: "crm-token",
      field: null,
    });
  });

  test("reads a person item with a field", () => {
    expect(parseVaultHandle(["me", "erp", "password"])).toEqual({
      scope: "person",
      name: "erp",
      field: "password",
    });
  });

  test("reads every known field", () => {
    for (const field of ["token", "username", "password"]) {
      expect(parseVaultHandle(["a", field])?.field ?? null).toBe(field as never);
    }
  });

  test("refuses empty paths, unknown fields, extra segments and bad names", () => {
    expect(parseVaultHandle([])).toBeNull();
    expect(parseVaultHandle(["me"])).toBeNull();
    expect(parseVaultHandle(["a", "secret"])).toBeNull();
    expect(parseVaultHandle(["a", "token", "x"])).toBeNull();
    expect(parseVaultHandle(["me", "a", "token", "x"])).toBeNull();
    expect(parseVaultHandle(["A"])).toBeNull();
    expect(parseVaultHandle(["me", "me"])).toBeNull();
  });
});

describe("formatting", () => {
  test("formats keys and placeholders for both scopes", () => {
    const person = { scope: "person", name: "erp", field: "password" } as const;
    const workspace = { scope: "workspace", name: "crm", field: null } as const;
    expect(vaultHandleKey(person)).toBe("me.erp");
    expect(vaultHandleKey(workspace)).toBe("crm");
    expect(formatVaultPlaceholder(person)).toBe("${secret.me.erp.password}");
    expect(formatVaultPlaceholder(workspace)).toBe("${secret.crm}");
  });
});

describe("vaultItemNameFrom", () => {
  test("lowercases and replaces other characters with dashes", () => {
    expect(vaultItemNameFrom("GitHub API.Token")).toBe("github-api-token");
  });

  test("collapses a run of other characters into one dash", () => {
    expect(vaultItemNameFrom("a!!b")).toBe("a-b");
  });

  test("drops every trailing dash", () => {
    expect(vaultItemNameFrom("ab---")).toBe("ab");
    expect(vaultItemNameFrom("ab_")).toBe("ab_");
  });

  test("trims leading signs and trailing dashes", () => {
    expect(vaultItemNameFrom("--_Hello!!")).toBe("hello");
  });

  test("cuts to 63 characters without a trailing dash", () => {
    const name = vaultItemNameFrom(`${"a".repeat(62)}-b`);
    expect(name).toBe("a".repeat(62));
  });

  test("prefixes names that stay invalid", () => {
    expect(vaultItemNameFrom("me")).toBe("item-me");
    expect(vaultItemNameFrom("!!!")).toBe("item-");
  });
});

describe("secret references", () => {
  test("round-trips a versioned reference", () => {
    expect(secretReference("settings.llm.key", 3)).toBe("secret://settings.llm.key/3");
    expect(parseSecretReference("secret://settings.llm.key/3")).toEqual({
      name: "settings.llm.key",
      version: 3,
    });
  });

  test("refuses references without a positive version or with a bad name", () => {
    expect(parseSecretReference("secret://a/0")).toBeNull();
    expect(parseSecretReference("secret://a")).toBeNull();
    expect(parseSecretReference("secret://.a/1")).toBeNull();
    expect(parseSecretReference("xsecret://a/1")).toBeNull();
    expect(parseSecretReference("secret://a/1x")).toBeNull();
  });

  test("checks names", () => {
    expect(isSecretName("A.b-c_1")).toBe(true);
    expect(isSecretName(".a")).toBe(false);
    expect(isSecretName("a".repeat(256))).toBe(false);
  });

  test("finds references deep in values", () => {
    expect(containsSecretReference({ a: [1, { b: "secret://x/1" }] })).toBe(true);
    expect(containsSecretReference({ a: [1, { b: "plain" }] })).toBe(false);
    expect(containsSecretReference(null)).toBe(false);
    expect(containsSecretReference(5)).toBe(false);
    expect(containsSecretReference(undefined)).toBe(false);
    expect(containsSecretReference(["x", "secret://y/2"])).toBe(true);
  });
});
