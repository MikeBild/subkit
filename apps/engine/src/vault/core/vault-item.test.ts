import { describe, expect, test } from "bun:test";
import {
  connectorItemName,
  handleMatches,
  isEditableKind,
  mergedLoginValue,
  normalizeItemName,
  templateClientItemName,
  VAULT_PERMISSION,
  type VaultItemKind,
  vaultAccess,
  vaultFieldValue,
  vaultRotationOf,
  vaultScopeOf,
  vaultSecretsOf,
  vaultValueOf,
  withNameSuffix,
} from "./vault-item.ts";

const ALL = new Set(Object.values(VAULT_PERMISSION));
const READ_ONLY = new Set([VAULT_PERMISSION.read]);
const NONE = new Set<string>();

describe("permissions", () => {
  test("each action maps to its vault permission", () => {
    expect(VAULT_PERMISSION).toEqual({
      read: "vault:read",
      write: "vault:write",
      rotate: "vault:rotate",
      delete: "vault:delete",
      reveal: "vault:reveal",
      use: "vault:use",
    });
  });
});

describe("names", () => {
  test("connector items are named after slug, environment and mode", () => {
    expect(connectorItemName("GitHub.API", "prod", "oauth2_client")).toBe(
      "github-api-prod-oauth2_client",
    );
  });

  test("connector item names stop at 54 characters without a trailing sign", () => {
    const name = connectorItemName("a".repeat(51), "dev", "bearer");
    expect(name).toBe(`${"a".repeat(51)}-de`);
    expect(connectorItemName("a".repeat(53), "dev", "bearer")).toBe("a".repeat(53));
    expect(connectorItemName("a".repeat(60), "dev", "bearer")).toHaveLength(54);
  });

  test("a cut name loses every trailing sign", () => {
    expect(connectorItemName(`${"a".repeat(52)}_-b`, "dev", "bearer")).toBe("a".repeat(52));
  });

  test("template clients carry a template prefix", () => {
    expect(templateClientItemName("Slack App")).toBe("template-slack-app");
  });

  test("a suffix keeps the name within 63 characters", () => {
    expect(withNameSuffix("a".repeat(63), "12345678")).toBe(`${"a".repeat(54)}-12345678`);
    expect(withNameSuffix("crm", "x")).toBe("crm-x");
  });

  test("user names are accepted only when already valid", () => {
    expect(normalizeItemName("  crm-token ")).toBe("crm-token");
    expect(normalizeItemName("CRM")).toBeNull();
    expect(normalizeItemName("me")).toBeNull();
  });
});

describe("scope and kinds", () => {
  test("an owner makes an item personal", () => {
    expect(vaultScopeOf({ owner_user_id: "u1" })).toBe("person");
    expect(vaultScopeOf({ owner_user_id: null })).toBe("workspace");
  });

  test("entries are edited in the vault, connector and template items on their connector", () => {
    const kinds: VaultItemKind[] = [
      "connector",
      "secret",
      "login",
      "template_client",
      "card",
      "bank_account",
      "identity",
      "address",
      "note",
    ];
    expect(kinds.filter(isEditableKind)).toEqual([
      "secret",
      "login",
      "card",
      "bank_account",
      "identity",
      "address",
      "note",
    ]);
  });
});

describe("vaultAccess", () => {
  const workspace = { kind: "secret" as const, owner_user_id: null };
  const connector = { kind: "connector" as const, owner_user_id: null };
  const mine = { kind: "login" as const, owner_user_id: "u1" };

  test("a personal item is allowed to its owner for every action, hidden from others", () => {
    for (const action of ["read", "write", "rotate", "delete", "reveal", "use"] as const) {
      expect(vaultAccess({ user_id: "u1", permissions: NONE }, mine, action)).toBe("allow");
      expect(vaultAccess({ user_id: "u2", permissions: ALL }, mine, action)).toBe("hidden");
      expect(vaultAccess({ user_id: null, permissions: ALL }, mine, action)).toBe("hidden");
    }
  });

  test("workspace items are hidden without vault:read", () => {
    expect(vaultAccess({ user_id: "u1", permissions: NONE }, workspace, "read")).toBe("hidden");
  });

  test("workspace actions need their own permission", () => {
    const reader = { user_id: "u1", permissions: READ_ONLY };
    expect(vaultAccess(reader, workspace, "read")).toBe("allow");
    for (const action of ["write", "rotate", "delete", "reveal", "use"] as const) {
      expect(vaultAccess(reader, workspace, action)).toBe("denied");
      expect(vaultAccess({ user_id: "u1", permissions: ALL }, workspace, action)).toBe("allow");
    }
  });

  test("connector items are read, revealed and deleted here but changed on the connector", () => {
    const admin = { user_id: "u1", permissions: ALL };
    expect(vaultAccess(admin, connector, "read")).toBe("allow");
    expect(vaultAccess(admin, connector, "reveal")).toBe("allow");
    expect(vaultAccess(admin, connector, "delete")).toBe("allow");
    expect(vaultAccess(admin, connector, "write")).toBe("denied");
    expect(vaultAccess(admin, connector, "rotate")).toBe("denied");
  });
});

describe("values", () => {
  test("a secret needs a token, a login a username and a password", () => {
    expect(vaultValueOf("secret", { token: "t" })).toEqual({ kind: "secret", token: "t" });
    expect(vaultValueOf("secret", {})).toBe("a secret needs a token");
    expect(vaultValueOf("login", { username: "u", password: "p" })).toEqual({
      kind: "login",
      username: "u",
      password: "p",
    });
    expect(vaultValueOf("login", { username: "u" })).toBe(
      "a login needs a username and a password",
    );
    expect(vaultValueOf("login", { password: "p" })).toBe(
      "a login needs a username and a password",
    );
  });

  test("a login rotation may change one field and keeps the stored other", () => {
    expect(vaultRotationOf("login", { password: "p2" })).toEqual({
      kind: "login_patch",
      password: "p2",
    });
    expect(vaultRotationOf("login", { username: "u2" })).toEqual({
      kind: "login_patch",
      username: "u2",
    });
    expect(vaultRotationOf("login", { password: "" })).toBe("a login needs a password");
    expect(vaultRotationOf("login", { username: "" })).toBe("a login needs a username");
    expect(vaultRotationOf("login", { username: "u", password: "" })).toBe(
      "a login needs a username and a password",
    );
    expect(vaultRotationOf("secret", { username: "u" })).toBe("a secret needs a token");
    const stored = { username: "u", password: "p" };
    expect(mergedLoginValue(stored, { kind: "login_patch", password: "p2" })).toEqual({
      kind: "login",
      username: "u",
      password: "p2",
    });
    expect(mergedLoginValue(stored, { kind: "login_patch", username: "u2" })).toEqual({
      kind: "login",
      username: "u2",
      password: "p",
    });
    expect(mergedLoginValue({}, { kind: "login_patch", password: "p2" })).toBe(
      "a login needs a username and a password",
    );
  });

  test("fields pick the injected value", () => {
    const secret = { kind: "secret" as const, token: "t" };
    const login = { kind: "login" as const, username: "u", password: "p" };
    expect(vaultFieldValue(secret, null)).toBe("t");
    expect(vaultFieldValue(secret, "token")).toBe("t");
    expect(vaultFieldValue(secret, "password")).toBeNull();
    expect(vaultFieldValue(login, "username")).toBe("u");
    expect(vaultFieldValue(login, "password")).toBe("p");
    expect(vaultFieldValue(login, null)).toBeNull();
    expect(vaultFieldValue(login, "token")).toBeNull();
    const card = {
      kind: "card" as const,
      number: "4111111111111111",
      exp_month: 1,
      exp_year: 2040,
      holder: "A",
    };
    expect(vaultFieldValue(card, "number")).toBeNull();
    expect(vaultFieldValue(card, null)).toBeNull();
  });

  test("a login rotation keeps the one-time code key unless the patch replaces or removes it", () => {
    const stored = { username: "u", password: "p", totp_seed: "JBSWY3DPEHPK3PXP" };
    expect(mergedLoginValue(stored, { kind: "login_patch", password: "p2" })).toEqual({
      kind: "login",
      username: "u",
      password: "p2",
      totp_seed: "JBSWY3DPEHPK3PXP",
    });
    expect(mergedLoginValue(stored, { kind: "login_patch", totp_seed: null })).toEqual({
      kind: "login",
      username: "u",
      password: "p",
    });
    expect(
      mergedLoginValue(stored, { kind: "login_patch", totp_seed: "GEZDGNBVGY3TQOJQ" }),
    ).toMatchObject({ totp_seed: "GEZDGNBVGY3TQOJQ" });
  });

  test("secrets to redact are the token or the password, not the username", () => {
    expect(vaultSecretsOf({ kind: "secret", token: "t" })).toEqual(["t"]);
    expect(vaultSecretsOf({ kind: "login", username: "u", password: "p" })).toEqual(["p"]);
  });
});

describe("handleMatches", () => {
  const workspaceItem = { name: "crm", owner_user_id: null };
  const personal = { name: "crm", owner_user_id: "u1" };

  test("a workspace handle matches only the workspace item of that name", () => {
    const handle = { scope: "workspace", name: "crm", field: null } as const;
    expect(handleMatches(handle, workspaceItem, "u1")).toBe(true);
    expect(handleMatches(handle, personal, "u1")).toBe(false);
    expect(handleMatches({ ...handle, name: "erp" }, workspaceItem, "u1")).toBe(false);
  });

  test("a person handle matches only the running person's own item", () => {
    const handle = { scope: "person", name: "crm", field: null } as const;
    expect(handleMatches(handle, personal, "u1")).toBe(true);
    expect(handleMatches(handle, personal, "u2")).toBe(false);
    expect(handleMatches(handle, personal, null)).toBe(false);
    expect(handleMatches(handle, workspaceItem, null)).toBe(false);
    expect(handleMatches(handle, workspaceItem, "u1")).toBe(false);
  });
});
