import { describe, expect, test } from "bun:test";
import { decidedByAuditActor, decidedByFor } from "./decided-by.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";

describe("decidedByFor", () => {
  test("no actor means nobody decided", () => {
    expect(
      decidedByFor(null, TENANT, { id: BOT, kind: "system_account", tenant_id: TENANT }),
    ).toBeNull();
    expect(decidedByFor(null, TENANT, null)).toBeNull();
    expect(decidedByFor(null, TENANT, undefined)).toBeNull();
  });

  test("a matching same-tenant principal keeps its own kind", () => {
    expect(
      decidedByFor(BOT, TENANT, { id: BOT, kind: "system_account", tenant_id: TENANT }),
    ).toEqual({ id: BOT, kind: "system_account" });
    expect(decidedByFor(USER, TENANT, { id: USER, kind: "user", tenant_id: TENANT })).toEqual({
      id: USER,
      kind: "user",
    });
  });

  test("a mismatched, missing, or cross-tenant principal does not establish a human decider", () => {
    expect(
      decidedByFor(USER, TENANT, { id: BOT, kind: "system_account", tenant_id: TENANT }),
    ).toEqual({ id: null, kind: "unknown" });
    expect(decidedByFor(USER, TENANT, null)).toEqual({ id: null, kind: "unknown" });
    expect(decidedByFor(USER, TENANT, { id: USER, kind: "user", tenant_id: BOT })).toEqual({
      id: null,
      kind: "unknown",
    });
  });

  test("an explicit human answer establishes the approver over the run-as principal", () => {
    expect(
      decidedByFor(
        BOT,
        TENANT,
        { id: BOT, kind: "system_account", tenant_id: TENANT },
        {
          kind: "human",
          user_id: USER,
          via: "portal",
        },
      ),
    ).toEqual({ id: USER, kind: "user" });
    expect(
      decidedByFor(USER, TENANT, null, { kind: "human", user_id: BOT, via: "portal" }),
    ).toEqual({ id: BOT, kind: "user" });
  });

  test("unknown and absent deciders remain distinct in audit attribution", () => {
    expect(decidedByAuditActor(decidedByFor(USER, TENANT, null))).toEqual({
      actor_type: "unknown",
      actor_id: null,
    });
    expect(decidedByAuditActor(decidedByFor(null, TENANT, null))).toEqual({
      actor_type: "system",
      actor_id: null,
    });
  });
});
