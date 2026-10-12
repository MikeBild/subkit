import { describe, expect, test } from "bun:test";
import { requestEgressActor } from "../steps/request/dispatch.ts";

describe("requestEgressActor", () => {
  test("keeps an absent principal unknown without an actor ID", () => {
    expect(requestEgressActor(undefined)).toEqual({ actor_type: "unknown", actor_id: null });
    expect(requestEgressActor(null)).toEqual({ actor_type: "unknown", actor_id: null });
  });

  test("preserves a trusted UUID user principal", () => {
    expect(
      requestEgressActor({ kind: "user", id: "00000000-0000-4000-8000-000000000001" }),
    ).toEqual({
      actor_type: "user",
      actor_id: "00000000-0000-4000-8000-000000000001",
    });
  });

  test("preserves a trusted UUID system account principal", () => {
    expect(
      requestEgressActor({
        kind: "system_account",
        id: "00000000-0000-4000-8000-000000000002",
      }),
    ).toEqual({
      actor_type: "system_account",
      actor_id: "00000000-0000-4000-8000-000000000002",
    });
  });

  test("keeps an opaque portal owner typed without writing it into a UUID actor column", () => {
    expect(requestEgressActor({ kind: "user", id: "external-crm-contact-42" })).toEqual({
      actor_type: "user",
      actor_id: null,
    });
  });
});
