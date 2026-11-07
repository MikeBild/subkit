import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  type Actor,
  actorFromColumns,
  actorIds,
  actorOf,
  actorType,
  auditActor,
} from "../actor.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const actorArb = fc.record({
  kind: fc.constantFrom("user" as const, "system_account" as const),
  id: fc.uuid(),
});

describe("actor attribution", () => {
  test("a user principal is attributed as user and a system account as system_account", () => {
    expect(actorType({ kind: "user" })).toBe("user");
    expect(actorType({ kind: "system_account" })).toBe("system_account");
  });

  test("actorOf keeps only the kind and id of a principal", () => {
    const principal = { kind: "user" as const, id: USER_ID, email: "a@example.com" };
    expect(actorOf(principal)).toEqual({ kind: "user", id: USER_ID });
  });

  test("a missing actor is recorded as the system with no actor id", () => {
    expect(auditActor(null)).toEqual({ actor_type: "system", actor_id: null });
  });

  test("a present actor is recorded with its own type and id", () => {
    expect(auditActor({ kind: "user", id: USER_ID })).toEqual({
      actor_type: "user",
      actor_id: USER_ID,
    });
    expect(auditActor({ kind: "system_account", id: ACCOUNT_ID })).toEqual({
      actor_type: "system_account",
      actor_id: ACCOUNT_ID,
    });
  });

  test("actorIds fills exactly the column that matches the actor kind", () => {
    expect(actorIds({ kind: "user", id: USER_ID })).toEqual({
      user_id: USER_ID,
      system_account_id: null,
    });
    expect(actorIds({ kind: "system_account", id: ACCOUNT_ID })).toEqual({
      user_id: null,
      system_account_id: ACCOUNT_ID,
    });
    expect(actorIds(null)).toEqual({ user_id: null, system_account_id: null });
  });

  test("actorFromColumns prefers the user column and returns null when both are empty", () => {
    expect(actorFromColumns(USER_ID, ACCOUNT_ID)).toEqual({ kind: "user", id: USER_ID });
    expect(actorFromColumns(null, ACCOUNT_ID)).toEqual({ kind: "system_account", id: ACCOUNT_ID });
    expect(actorFromColumns("", "")).toBeNull();
    expect(actorFromColumns(null, null)).toBeNull();
  });

  test("columns written by actorIds read back as the same actor", () => {
    fc.assert(
      fc.property(fc.option(actorArb, { nil: null }), (actor: Actor | null) => {
        const cols = actorIds(actor);
        expect(actorFromColumns(cols.user_id, cols.system_account_id)).toEqual(actor);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("an actor never fills both id columns and auditActor never invents an id", () => {
    fc.assert(
      fc.property(fc.option(actorArb, { nil: null }), (actor: Actor | null) => {
        const cols = actorIds(actor);
        expect(cols.user_id !== null && cols.system_account_id !== null).toBe(false);
        expect(auditActor(actor).actor_id).toBe(actor ? actor.id : null);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});
