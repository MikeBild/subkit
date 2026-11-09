import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  type ApiKeyCreator,
  apiKeyActorId,
  decideApiKeyRotation,
  decideApiKeyRotationOwner,
  decideCredentialCreator,
  decideCredentialIssue,
  rotationOverlapDeadline,
} from "./credentials.ts";

test("creator provenance preserves absent, anonymous, system and identified callers", () => {
  expect(decideCredentialCreator(undefined, "legacy")).toEqual({ kind: "accepted", actor: null });
  const actors: ReadonlyArray<ApiKeyCreator | null> = [
    null,
    { kind: "system", id: null },
    { kind: "user", id: "person" },
    { kind: "system_account", id: "machine" },
  ];
  for (const actor of actors) {
    const id = actor?.kind === "user" || actor?.kind === "system_account" ? actor.id : null;
    expect(apiKeyActorId(actor)).toBe(id);
    expect(decideCredentialCreator(actor, undefined)).toEqual({ kind: "accepted", actor });
    expect(decideCredentialCreator(actor, id)).toEqual({ kind: "accepted", actor });
    expect(decideCredentialCreator(actor, "different")).toEqual({ kind: "provenance_mismatch" });
  }
  expect(apiKeyActorId(undefined)).toBeNull();
});

test("rotation retains historical owner precedence and reports missing owner kinds", () => {
  expect(decideApiKeyRotationOwner({ user_id: "user", system_account_id: "machine" })).toEqual({
    kind: "accepted",
    owner_kind: "user",
    owner_id: "user",
  });
  expect(decideApiKeyRotationOwner({ user_id: null, system_account_id: "machine" })).toEqual({
    kind: "accepted",
    owner_kind: "system_account",
    owner_id: "machine",
  });
  for (const user_id of [null, ""])
    expect(decideApiKeyRotationOwner({ user_id, system_account_id: null })).toEqual({
      kind: "owner_missing",
      owner_kind: "system_account",
    });
  expect(decideApiKeyRotationOwner({ user_id: "", system_account_id: "machine" })).toEqual({
    kind: "owner_missing",
    owner_kind: "system_account",
  });
  expect(
    decideApiKeyRotation(
      { user_id: null, system_account_id: null },
      { owner_found_in_tenant: true },
    ),
  ).toEqual({ kind: "owner_missing", owner_kind: "system_account" });
});

test("credential issue and rotation decisions preserve owner and tenant rejection tags", () => {
  expect(
    decideCredentialIssue({
      owner_kind: "user",
      owner_id: "owner",
      owner_found_in_tenant: true,
    }),
  ).toEqual({ kind: "accepted", owner_kind: "user", owner_id: "owner" });
  expect(
    decideCredentialIssue({
      owner_kind: "user",
      owner_id: "owner",
      owner_found_in_tenant: false,
    }),
  ).toEqual({ kind: "owner_not_in_tenant", owner_kind: "user" });
  expect(
    decideCredentialIssue({
      owner_kind: "system_account",
      owner_id: null,
      owner_found_in_tenant: false,
    }),
  ).toEqual({ kind: "owner_missing", owner_kind: "system_account" });
  expect(
    decideApiKeyRotation(
      { user_id: null, system_account_id: "machine" },
      { owner_found_in_tenant: false },
    ),
  ).toEqual({ kind: "owner_not_in_tenant", owner_kind: "system_account" });
});

test("overlap uses explicit time and preserves zero, negative and default durations", () => {
  expect(rotationOverlapDeadline(42, undefined)).toBe(3_600_042);
  expect(rotationOverlapDeadline(42, 0)).toBe(42);
  expect(rotationOverlapDeadline(42, -1)).toBe(-59_958);
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2_000_000_000 }),
      fc.integer({ min: -100, max: 1000 }),
      (time, minutes) => {
        expect(rotationOverlapDeadline(time, minutes) - time).toBe(minutes * 60_000);
        const actor = Object.freeze({ kind: "user" as const, id: String(time) });
        expect(decideCredentialCreator(actor, actor.id)).toEqual({ kind: "accepted", actor });
        expect(actor.id).toBe(String(time));
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
