import { describe, expect, test } from "bun:test";
import { auditActor } from "../audit/actor.ts";
import { decidedByFor } from "./decided-by.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";

describe("decidedByFor", () => {
  test("no actor means nobody decided", () => {
    expect(decidedByFor(null, { id: BOT, kind: "system_account" })).toBeNull();
    expect(decidedByFor(null, null)).toBeNull();
    expect(decidedByFor(null, undefined)).toBeNull();
  });

  test("the acting principal keeps its own kind", () => {
    expect(decidedByFor(BOT, { id: BOT, kind: "system_account" })).toEqual({
      id: BOT,
      kind: "system_account",
    });
    expect(decidedByFor(USER, { id: USER, kind: "user" })).toEqual({ id: USER, kind: "user" });
  });

  test("an actor other than the principal is a human user", () => {
    expect(decidedByFor(USER, { id: BOT, kind: "system_account" })).toEqual({
      id: USER,
      kind: "user",
    });
    expect(decidedByFor(USER, null)).toEqual({ id: USER, kind: "user" });
    expect(decidedByFor(USER, undefined)).toEqual({ id: USER, kind: "user" });
  });

  test("the decider maps onto the audit actor columns", () => {
    expect(auditActor(decidedByFor(BOT, { id: BOT, kind: "system_account" }))).toEqual({
      actor_type: "system_account",
      actor_id: BOT,
    });
    expect(auditActor(decidedByFor(USER, { id: BOT, kind: "system_account" }))).toEqual({
      actor_type: "user",
      actor_id: USER,
    });
    expect(auditActor(decidedByFor(null, null))).toEqual({ actor_type: "system", actor_id: null });
  });
});
