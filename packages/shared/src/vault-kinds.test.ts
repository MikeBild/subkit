import { describe, expect, test } from "bun:test";
import { CONNECTOR_STEP_FIELDS, parseVaultHandle, VAULT_FIELDS } from "./vault-handle.ts";
import {
  fieldsOfKind,
  isPersonalOnlyKind,
  needsFreshAuthToReveal,
  PERSONAL_ONLY_KINDS,
  usableInConnectorSteps,
} from "./vault-kinds.ts";

describe("vault kinds", () => {
  test("cards, bank accounts and identities are personal only", () => {
    expect([...PERSONAL_ONLY_KINDS]).toEqual(["card", "bank_account", "identity"]);
    expect(isPersonalOnlyKind("address")).toBe(false);
  });

  test("only cards and bank accounts need a fresh sign-in to reveal", () => {
    expect(needsFreshAuthToReveal("card")).toBe(true);
    expect(needsFreshAuthToReveal("bank_account")).toBe(true);
    expect(needsFreshAuthToReveal("identity")).toBe(false);
    expect(needsFreshAuthToReveal("login")).toBe(false);
  });

  test("only secrets and logins go into connector steps", () => {
    expect(["secret", "login", "card", "bank_account"].filter(usableInConnectorSteps)).toEqual([
      "secret",
      "login",
    ]);
  });

  test("field names per kind; a card never has a security code field", () => {
    expect(fieldsOfKind("card")).toEqual(["number", "exp_month", "exp_year", "holder"]);
    expect(fieldsOfKind("connector")).toEqual([]);
    expect(VAULT_FIELDS).not.toContain("cvv");
  });
});

describe("handles", () => {
  test("keep working for secrets and logins and accept the new field names", () => {
    expect(parseVaultHandle(["crm", "password"])).toEqual({
      scope: "workspace",
      name: "crm",
      field: "password",
    });
    expect(parseVaultHandle(["me", "visa", "number"])).toEqual({
      scope: "person",
      name: "visa",
      field: "number",
    });
    expect(parseVaultHandle(["crm", "cvv"])).toBeNull();
    expect([...CONNECTOR_STEP_FIELDS]).toEqual(["token", "username", "password"]);
  });
});
