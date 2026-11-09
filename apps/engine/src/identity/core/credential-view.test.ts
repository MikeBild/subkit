import { expect, test } from "bun:test";
import fc from "fast-check";
import { type ApiKeyViewFacts, toApiKeyView } from "./credential-view.ts";
import type { ApiKeyCreator } from "./credentials.ts";

const facts: ApiKeyViewFacts = {
  id: "key",
  tenant_id: "tenant",
  prefix: "prefix",
  name: null,
  scopes: ["workflow:read"],
  user_id: null,
  system_account_id: null,
  creator_kind: null,
  creator_id: null,
  allowed_workflows: null,
  allowed_connectors: null,
  created_at: new Date(0),
  last_used_at: null,
  expires_at: null,
  rotating_out_at: null,
  rotated_from_id: null,
  revoked_at: null,
};

test("credential views preserve nullable metadata without exposing storage-only facts", () => {
  const secretFacts = {
    ...facts,
    token_sha256: "secret-hash",
    credential_origin: "cli_oauth_session",
  };
  const view = toApiKeyView(secretFacts);
  const { creator_kind: _kind, creator_id: _id, ...expected } = facts;
  expect(view).toEqual({ ...expected, creator: null });
  expect(Object.keys(view)).not.toContain("token_sha256");
  expect(Object.keys(view)).not.toContain("credential_origin");
  const populated = {
    ...facts,
    name: "Access",
    user_id: "owner",
    system_account_id: "machine",
    allowed_workflows: ["workflow"],
    allowed_connectors: ["connector"],
    last_used_at: new Date(1),
    expires_at: new Date(2),
    rotating_out_at: new Date(3),
    rotated_from_id: "old",
    revoked_at: new Date(4),
  };
  const { creator_kind: _popKind, creator_id: _popId, ...populatedExpected } = populated;
  expect(toApiKeyView(populated)).toEqual({ ...populatedExpected, creator: null });
});

test("creator identity requires a valid kind and matching stored identifier shape", () => {
  for (const creator_kind of [null, "unknown", "user", "system_account", "system"]) {
    for (const creator_id of [null, "", "creator"]) {
      const expected: ApiKeyCreator | null =
        (creator_kind === "user" || creator_kind === "system_account") && creator_id
          ? { kind: creator_kind, id: creator_id }
          : creator_kind === "system" && creator_id === null
            ? { kind: "system", id: null }
            : null;
      expect(toApiKeyView({ ...facts, creator_kind, creator_id }).creator).toEqual(expected);
    }
  }
});

test("projection is deterministic and does not mutate supplied record facts", () => {
  fc.assert(
    fc.property(fc.string(), fc.array(fc.string(), { maxLength: 5 }), (name, scopes) => {
      const row = Object.freeze({ ...facts, name, scopes });
      const before = JSON.stringify(row);
      expect(toApiKeyView(row)).toEqual(toApiKeyView(row));
      expect(JSON.stringify(row)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
