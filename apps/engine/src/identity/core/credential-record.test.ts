import { expect, test } from "bun:test";
import fc from "fast-check";
import { credentialIssueMetadata, credentialStorageValues } from "./credential-record.ts";
import type { ApiKeyCreator } from "./credentials.ts";

const facts = {
  tenant_id: "tenant",
  user_id: "owner",
  system_account_id: null,
  scopes: ["workflow:read"],
  credential_origin: null,
};
const key = { prefix: "prefix", hash: "hash", plaintext: "never-store" };

test("credential records normalize optional fields and never store plaintext key material", () => {
  expect(credentialStorageValues(facts, null, key)).toEqual({
    tenant_id: "tenant",
    user_id: "owner",
    system_account_id: null,
    creator_kind: null,
    creator_id: null,
    credential_origin: null,
    prefix: "prefix",
    token_sha256: "hash",
    name: null,
    scopes: ["workflow:read"],
    allowed_workflows: null,
    allowed_connectors: null,
    expires_at: null,
    rotated_from_id: null,
  });
  const actors: ApiKeyCreator[] = [
    { kind: "user", id: "creator" },
    { kind: "system_account", id: "machine" },
    { kind: "system", id: null },
  ];
  const expires_at = new Date(5);
  for (const actor of actors) {
    const record = credentialStorageValues(
      {
        ...facts,
        user_id: null,
        system_account_id: "owner-machine",
        name: "named",
        allowed_workflows: ["w"],
        allowed_connectors: ["c"],
        expires_at,
        rotated_from_id: "previous",
        credential_origin: "cli_oauth_session",
      },
      actor,
      key,
    );
    expect(record).toEqual({
      ...facts,
      user_id: null,
      system_account_id: "owner-machine",
      name: "named",
      allowed_workflows: ["w"],
      allowed_connectors: ["c"],
      expires_at,
      rotated_from_id: "previous",
      credential_origin: "cli_oauth_session",
      creator_kind: actor.kind,
      creator_id: actor.id,
      prefix: key.prefix,
      token_sha256: key.hash,
    });
    expect(record.scopes).toBe(facts.scopes);
  }
});

test("audit metadata contains only owner, public prefix and rotation provenance", () => {
  expect(
    credentialIssueMetadata({ owner_kind: "user", owner_id: "owner", prefix: "prefix" }),
  ).toEqual({ owner_kind: "user", owner_id: "owner", prefix: "prefix", rotated_from_id: null });
  expect(
    credentialIssueMetadata({
      owner_kind: "system_account",
      owner_id: null,
      prefix: "prefix",
      rotated_from_id: "prior",
    }),
  ).toEqual({
    owner_kind: "system_account",
    owner_id: null,
    prefix: "prefix",
    rotated_from_id: "prior",
  });
});

test("record projection preserves retained scopes and does not mutate facts", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 20 }), (scopes) => {
      const input = Object.freeze({ ...facts, scopes });
      const before = JSON.stringify(input);
      expect(credentialStorageValues(input, null, key).scopes).toEqual(scopes);
      expect(JSON.stringify(input)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
