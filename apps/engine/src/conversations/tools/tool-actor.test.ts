import { describe, expect, test } from "bun:test";
import { toolActor } from "./tool-actor.ts";

describe("toolActor", () => {
  test("does not infer a user from an actor id without a typed principal", () => {
    expect(toolActor({ principal: null, actor_id: "actor-id" })).toBeNull();
  });

  test("preserves the kind of a typed system account principal", () => {
    expect(
      toolActor({
        principal: {
          provider: "test",
          kind: "system_account",
          id: "system-account-id",
          tenant_id: "tenant-id",
          roles: [],
        },
        actor_id: "system-account-id",
      }),
    ).toEqual({ kind: "system_account", id: "system-account-id" });
  });
});
