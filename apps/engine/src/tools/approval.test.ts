// Unit coverage for the pure / no-DB-touch parts of the approval store.
//
// `consumeApproval` short-circuits BEFORE it ever reaches Postgres for two
// inputs: a missing `confirm_id` and a syntactically-invalid one (the `uuid`
// column would abort the statement rather than resolve to "no such
// approval" — see the `UUID_RE` comment in approval.ts). Both branches are
// pure and unit-testable with a `db` stub that throws if touched, proving
// the short-circuit actually happens — including that neither mints an
// `audit_log` row off a model-suppliable garbage string.
//
// The DB-backed lifecycle (request → consume, single-use, expiry, wrong
// principal, wrong tool, tamper-at-rest, audit resource_id linkage) lives in
// approval.int.test.ts against a real Postgres — `consumeApproval`'s CAS and
// `requestApproval`'s encrypt-then-insert are not meaningfully mockable.

import { describe, expect, test } from "bun:test";
import type { Db } from "../db/client.ts";
import { consumeApproval, hashToolArgs, stripConfirmMarkers } from "./approval.ts";
import { makeTestPrincipal } from "./tests/_helpers.ts";

/** A `db` that throws the moment anything touches it — proves the branch
 *  under test never reaches Postgres. */
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
