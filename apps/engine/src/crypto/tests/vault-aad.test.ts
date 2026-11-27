import { describe, expect, test } from "bun:test";
import {
  sha256HexOfBytes,
  vaultItemAadCandidates,
  vaultItemAadV1,
  vaultItemAadV2,
} from "../index.ts";

describe("vault item AAD", () => {
  test("v2 binds tenant, owner or workspace, id and kind", () => {
    expect(vaultItemAadV2({ tenant_id: "t", owner_user_id: "u", id: "i", kind: "card" })).toBe(
      "vault:v2:t:u:i:card",
    );
    expect(vaultItemAadV2({ tenant_id: "t", owner_user_id: null, id: "i", kind: "login" })).toBe(
      "vault:v2:t:workspace:i:login",
    );
  });

  test("v1 stays the credential binding and is tried after v2", () => {
    expect(vaultItemAadV1("t", "i")).toBe("credential:t:i");
    expect(
      vaultItemAadCandidates({ tenant_id: "t", owner_user_id: null, id: "i", kind: "secret" }),
    ).toEqual(["vault:v2:t:workspace:i:secret", "credential:t:i"]);
  });

  test("the digest is the sha256 of the bytes", () => {
    expect(sha256HexOfBytes(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
