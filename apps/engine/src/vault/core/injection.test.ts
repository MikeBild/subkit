import { describe, expect, test } from "bun:test";
import { injectVaultValue, type PreparedVaultValues, vaultValueKey } from "./injection.ts";

const TOKEN = "${secret.crm-token}";
const values: PreparedVaultValues = new Map([
  ["${secret.crm-token}", { ok: true, value: "s3cr3t", secrets: ["s3cr3t"] }],
  ["${secret.erp.password}", { ok: true, value: "pw-erp", secrets: ["pw-erp", "user-erp"] }],
  [
    "${secret.gone}",
    { ok: false, code: "key_not_found", message: "no vault item secret.gone in dev" },
  ],
]);

describe("vaultValueKey", () => {
  test("keys a handle by its placeholder, field and scope included", () => {
    expect(vaultValueKey({ scope: "workspace", name: "crm-token", field: null })).toBe(TOKEN);
    expect(vaultValueKey({ scope: "person", name: "erp", field: "password" })).toBe(
      "${secret.me.erp.password}",
    );
  });
});

describe("injectVaultValue", () => {
  test("hands out the prepared value with every value to redact", () => {
    expect(injectVaultValue(TOKEN, ["crm-token"], values)).toEqual({
      ok: true,
      value: "s3cr3t",
      secrets: ["s3cr3t"],
    });
    expect(injectVaultValue("${secret.erp.password}", ["erp", "password"], values)).toEqual({
      ok: true,
      value: "pw-erp",
      secrets: ["pw-erp", "user-erp"],
    });
  });

  test("withholds every handle outside a prepared connector step", () => {
    const result = injectVaultValue(TOKEN, ["crm-token"], null);
    expect(result).toMatchObject({ ok: false, code: "secret_withheld" });
    expect(JSON.stringify(result)).toContain(TOKEN);
    expect(JSON.stringify(result)).toContain("headers, query or body");
  });

  test("withholds a handle that was not prepared for this step", () => {
    expect(injectVaultValue("${secret.other}", ["other"], values)).toMatchObject({
      ok: false,
      code: "secret_withheld",
    });
  });

  test("passes on why a prepared handle has no value", () => {
    expect(injectVaultValue("${secret.gone}", ["gone"], values)).toEqual({
      ok: false,
      code: "key_not_found",
      message: "no vault item secret.gone in dev",
    });
  });

  test("refuses a malformed handle", () => {
    expect(injectVaultValue("${secret.Bad Name}", ["Bad Name"], values)).toEqual({
      ok: false,
      code: "parse_error",
      message: "malformed ${secret.Bad Name}",
    });
    expect(injectVaultValue("${secret.erp.pin}", ["erp", "pin"], values)).toMatchObject({
      ok: false,
      code: "parse_error",
    });
  });
});
