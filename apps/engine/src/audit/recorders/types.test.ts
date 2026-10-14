import { describe, expect, test } from "bun:test";
import { resolveActor } from "./types.ts";

describe("resolveActor", () => {
  test("preserves known actor type and ID", () => {
    expect(resolveActor({ tenant_id: "tenant", actor_id: "actor", actor_type: "user" })).toEqual({
      actor_type: "user",
      actor_id: "actor",
    });
  });

  test("does not infer a type from an actor ID", () => {
    expect(resolveActor({ tenant_id: "tenant", actor_id: "actor" })).toEqual({
      actor_type: "unknown",
      actor_id: null,
    });
  });

  test("clears an ID for an explicitly unknown actor", () => {
    expect(resolveActor({ tenant_id: "tenant", actor_id: "actor", actor_type: "unknown" })).toEqual(
      { actor_type: "unknown", actor_id: null },
    );
  });

  test("clears an ID for a system actor", () => {
    expect(resolveActor({ tenant_id: "tenant", actor_id: "actor", actor_type: "system" })).toEqual({
      actor_type: "system",
      actor_id: null,
    });
  });

  test("does not preserve a known actor type without its ID", () => {
    expect(resolveActor({ tenant_id: "tenant", actor_id: null, actor_type: "user" })).toEqual({
      actor_type: "unknown",
      actor_id: null,
    });
  });

  test("defaults an absent actor to system", () => {
    expect(resolveActor({ tenant_id: "tenant", actor_id: null })).toEqual({
      actor_type: "system",
      actor_id: null,
    });
  });
});
