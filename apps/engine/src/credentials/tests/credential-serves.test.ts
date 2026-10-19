import { describe, expect, test } from "bun:test";
import { credentialServesAuthType } from "../types.ts";

describe("credentialServesAuthType", () => {
  test("a secret serves only the sign-in of its own kind", () => {
    expect(credentialServesAuthType("bearer", "bearer")).toBe(true);
    expect(credentialServesAuthType("header", "header")).toBe(true);
    expect(credentialServesAuthType("oauth2", "bearer")).toBe(false);
    expect(credentialServesAuthType("header", "bearer")).toBe(false);
  });

  test("an account token serves every account sign-in and no secret sign-in", () => {
    expect(credentialServesAuthType("oauth2", "oauth2")).toBe(true);
    expect(credentialServesAuthType("oauth2", "connection")).toBe(true);
    expect(credentialServesAuthType("oauth2_client", "oauth2")).toBe(true);
    expect(credentialServesAuthType("bearer", "connection")).toBe(false);
  });

  test("a connector without sign-in has no credential", () => {
    expect(credentialServesAuthType("none", "bearer")).toBe(false);
    expect(credentialServesAuthType("none", "oauth2")).toBe(false);
  });

  test("a minted token keeps serving the connector it was set up for", () => {
    expect(credentialServesAuthType("bearer", "token_mint")).toBe(true);
    expect(credentialServesAuthType("oauth2_private_key", "oauth2_private_key")).toBe(true);
    expect(credentialServesAuthType("signed_jwt", "signed_jwt")).toBe(true);
    expect(credentialServesAuthType("signed_jwt", "bearer")).toBe(false);
    expect(credentialServesAuthType("signed_jwt", "oauth2")).toBe(false);
    expect(credentialServesAuthType("signed_jwt", "token_mint")).toBe(false);
  });
});
