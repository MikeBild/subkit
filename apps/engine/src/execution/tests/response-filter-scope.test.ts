// Pure unit tests for the FIELD / ITEM / ENTRY scope semantics.
// No DB, no engine bootstrap — just the applyResponseFilters function.

import { describe, expect, test } from "bun:test";
import type { ResponseFilter } from "../../workflows/types.ts";
import { applyResponseFilters, ResponseFilterFailError } from "../response-filter.ts";

describe("response-filter scope", () => {
  test("FIELD (default) masks only the matched key", () => {
    const filter: ResponseFilter = {
      target: "KEYS",
      action: "MASK",
      pattern: "^password$",
    };
    const out = applyResponseFilters([filter], {
      user: "alice",
      password: "hunter2",
      role: "admin",
    });
    expect(out).toEqual({
      user: "alice",
      password: "***redacted***",
      role: "admin",
    });
  });

  test("ITEM removes the entire containing object when any descendant matches", () => {
    const filter: ResponseFilter = {
      target: "KEYS",
      action: "REMOVE",
      pattern: "^password$",
      scope: "ITEM",
    };
    const out = applyResponseFilters([filter], {
      team: [
        { id: 1, user: "alice", password: "hunter2" },
        { id: 2, user: "bob" },
      ],
    }) as { team: unknown[] };
    // Alice has a password field, so the whole object is dropped.
    // Bob stays because his subtree has no matching key.
    expect(out.team).toHaveLength(1);
    expect(out.team[0]).toEqual({ id: 2, user: "bob" });
  });

  test("ITEM masks the entire object when any descendant matches", () => {
    const filter: ResponseFilter = {
      target: "VALUES",
      action: "MASK",
      pattern: "SECRET-\\d+",
      scope: "ITEM",
      mask: "[REDACTED]",
    };
    const out = applyResponseFilters([filter], {
      records: [
        { id: 1, notes: "nothing here" },
        { id: 2, notes: "contains SECRET-42" },
      ],
    }) as { records: unknown[] };
    expect(out.records[0]).toEqual({ id: 1, notes: "nothing here" });
    expect(out.records[1]).toBe("[REDACTED]");
  });

  test("ENTRY drops the top-level array element when a nested descendant matches", () => {
    const filter: ResponseFilter = {
      target: "KEYS",
      action: "REMOVE",
      pattern: "^ssn$",
      scope: "ENTRY",
    };
    const rows = [
      { id: 1, profile: { email: "alice@example.com" } },
      { id: 2, profile: { email: "bob@example.com", ssn: "123-45-6789" } },
      { id: 3, profile: { email: "carol@example.com" } },
    ];
    const out = applyResponseFilters([filter], rows) as unknown[];
    // Bob's entire top-level row is dropped because his nested profile has ssn.
    expect(out).toHaveLength(2);
    expect((out[0] as { id: number }).id).toBe(1);
    expect((out[1] as { id: number }).id).toBe(3);
  });

  test("ENTRY falls back to ITEM semantics on a non-array root", () => {
    const filter: ResponseFilter = {
      target: "KEYS",
      action: "REMOVE",
      pattern: "^ssn$",
      scope: "ENTRY",
    };
    const out = applyResponseFilters([filter], {
      user: { name: "alice", ssn: "123-45-6789" },
      public: { name: "bob" },
    }) as Record<string, unknown>;
    expect(out.user).toBeUndefined();
    expect(out.public).toEqual({ name: "bob" });
  });

  test("FAIL action with ITEM scope throws at the containing object path", () => {
    const filter: ResponseFilter = {
      target: "KEYS",
      action: "FAIL",
      pattern: "^password$",
      scope: "ITEM",
    };
    expect(() =>
      applyResponseFilters([filter], {
        team: [{ id: 1, password: "hunter2" }],
      }),
    ).toThrow(ResponseFilterFailError);
  });
});
