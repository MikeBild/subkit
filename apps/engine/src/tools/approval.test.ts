import { describe, expect, test } from "bun:test";
import type { Db } from "../db/client.ts";
import { consumeApproval, hashToolArgs, stripConfirmMarkers } from "./approval.ts";
import { makeTestPrincipal } from "./tests/_helpers.ts";

function unreachableDb(): Db {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("consumeApproval must not touch the db for this input");
      },
    },
  ) as unknown as Db;
}

describe("approval.ts — stripConfirmMarkers / hashToolArgs (pure)", () => {
  test("hashToolArgs is invariant to the confirm control markers", () => {
    const domainArgs = { workflow: "invoice-export", environment: "prod" };
    const withMarkers = {
      ...domainArgs,
      __policy_confirmed: true,
      __policy_confirm_id: "11111111-2222-3333-4444-555555555555",
    };
    expect(hashToolArgs(withMarkers)).toBe(hashToolArgs(domainArgs));
  });

  test("hashToolArgs is invariant to key ordering", () => {
    const a = { workflow: "x", environment: "dev", input: { city: "Berlin", country: "DE" } };
    const b = { input: { country: "DE", city: "Berlin" }, environment: "dev", workflow: "x" };
    expect(hashToolArgs(a)).toBe(hashToolArgs(b));
  });

  test("hashToolArgs distinguishes different domain args", () => {
    expect(hashToolArgs({ id: "A" })).not.toBe(hashToolArgs({ id: "B" }));
  });

  test("stripConfirmMarkers drops only the two control keys", () => {
    const stripped = stripConfirmMarkers({
      id: "A",
      __policy_confirmed: true,
      __policy_confirm_id: "x",
    });
    expect(stripped).toEqual({ id: "A" });
  });
});

describe("consumeApproval — short-circuits that never touch the db", () => {
  test("approval_id === null → confirmation_missing_id, db untouched", async () => {
    const result = await consumeApproval({
      db: unreachableDb(),
      principal: makeTestPrincipal(),
      approval_id: null,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("confirmation_missing_id");
  });

  test("approval_id is not a uuid → unknown_confirmation, db untouched", async () => {
    const result = await consumeApproval({
      db: unreachableDb(),
      principal: makeTestPrincipal(),
      approval_id: "not-a-uuid",
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_confirmation");
  });
});
