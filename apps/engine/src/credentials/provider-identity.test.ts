import { expect, test } from "bun:test";
import { CredentialUseSnapshotSchema, identityFromTokenResponse } from "./provider-identity.ts";

test("only explicit provider subjects become identity and token material is excluded", () => {
  const issuer = "https://issuer.example.test";
  for (const value of [
    {},
    { username: "claimed" },
    { id_token: "unverified.jwt.value" },
    { sub: "" },
  ]) {
    expect(identityFromTokenResponse(issuer, value)).toBeNull();
  }
  expect(identityFromTokenResponse(issuer, { sub: "account", access_token: "secret" })).toEqual({
    issuer,
    subject: "account",
    source: "token_endpoint",
  });
});

test("credential snapshots strip secrets and retain independent token generation", () => {
  const result = CredentialUseSnapshotSchema.parse({
    connector_id: "10000000-0000-4000-8000-000000000001",
    environment: "prod",
    credential_id: null,
    credential_generation: 2,
    connection_id: "10000000-0000-4000-8000-000000000002",
    access_token_version: 7,
    identity: {
      issuer: "https://issuer.example.test",
      subject: "account",
      source: "token_endpoint",
      access_token: "secret",
    },
    access_token: "secret",
  });
  expect(result.access_token_version).toBe(7);
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("invalid or secret-bearing issuers cannot become provider identities", () => {
  for (const issuer of [
    "not a URL",
    "https://user:password@example.test",
    "https://example.test?token=secret",
    "https://example.test#secret",
  ]) {
    expect(identityFromTokenResponse(issuer, { sub: "account" })).toBeNull();
  }
});
