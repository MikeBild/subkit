import { beforeAll, describe, expect, test } from "bun:test";
import { authorizeRetainedScopes, ScopeExceedsIssuerError } from "../scope-issuance.ts";
import {
  addTenant,
  addUser,
  builtinRole,
  useAccessDb,
  userPrincipal,
} from "./workflow-start-access-fixtures.ts";

const h = useAccessDb("scope_retained", 20_261_110);

let tenantA: string;
let tenantOp: string;
let memberA: string;
let memberOp: string;
let adminOp: string;

const member = (extra = {}) => ({
  kind: "principal" as const,
  principal: userPrincipal(tenantA, memberA, ["member"], extra),
});

async function outcome(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "ok",
    (error: unknown) => error,
  );
}

beforeAll(async () => {
  tenantA = await addTenant(h, "sr-a");
  tenantOp = await addTenant(h, "sr-op", true);
  const adminRole = await builtinRole(h, "admin");
  const memberRole = await builtinRole(h, "member");
  memberA = await addUser(h, tenantA, "member@sr", memberRole);
  memberOp = await addUser(h, tenantOp, "member@sr-op", memberRole);
  adminOp = await addUser(h, tenantOp, "admin@sr-op", adminRole);
});

describe("authorizeRetainedScopes", () => {
  test("a login or system issuer may retain any scopes", async () => {
    expect(
      await outcome(authorizeRetainedScopes(h.db, { kind: "login" }, ["rbac:write"], tenantA)),
    ).toBe("ok");
    expect(await outcome(authorizeRetainedScopes(h.db, { kind: "system" }, null, tenantA))).toBe(
      "ok",
    );
  });

  test("an issuer may retain scopes its role holds", async () => {
    expect(
      await outcome(
        authorizeRetainedScopes(h.db, member(), ["workflow:read", "workflow:run"], tenantA),
      ),
    ).toBe("ok");
  });

  test("an issuer may not retain a scope its role lacks", async () => {
    const error = await outcome(
      authorizeRetainedScopes(h.db, member(), ["workflow:read", "rbac:write"], tenantA),
    );
    expect(error).toBeInstanceOf(ScopeExceedsIssuerError);
    expect((error as ScopeExceedsIssuerError).scopes).toEqual(["rbac:write"]);
  });

  test("a bounded issuer may not retain an unbounded key, stored as null or empty", async () => {
    for (const stored of [null, undefined, []]) {
      const error = await outcome(
        authorizeRetainedScopes(h.db, member({ scopes: ["workflow:read"] }), stored, tenantA),
      );
      expect(error).toBeInstanceOf(ScopeExceedsIssuerError);
      expect((error as ScopeExceedsIssuerError).scopes).toEqual(["*"]);
    }
  });

  test("an unbounded issuer may retain an unbounded key", async () => {
    expect(await outcome(authorizeRetainedScopes(h.db, member(), null, tenantA))).toBe("ok");
  });

  test("scopes no longer in the catalog are ignored", async () => {
    expect(
      await outcome(
        authorizeRetainedScopes(h.db, member(), ["workflow:read", "retired:scope"], tenantA),
      ),
    ).toBe("ok");
  });

  test("an operator-only scope on a key outside the operator tenant is ignored", async () => {
    expect(
      await outcome(
        authorizeRetainedScopes(h.db, member(), ["workflow:read", "metrics:read"], tenantA),
      ),
    ).toBe("ok");
  });

  test("ignoring an operator-only scope still checks the other retained scopes", async () => {
    const error = await outcome(
      authorizeRetainedScopes(h.db, member(), ["rbac:write", "metrics:read"], tenantA),
    );
    expect(error).toBeInstanceOf(ScopeExceedsIssuerError);
    expect((error as ScopeExceedsIssuerError).scopes).toEqual(["rbac:write"]);
  });

  test("an operator-only scope on an operator-tenant key needs an operator admin", async () => {
    const operatorMember = {
      kind: "principal" as const,
      principal: userPrincipal(tenantOp, memberOp, ["member"]),
    };
    const error = await outcome(
      authorizeRetainedScopes(h.db, operatorMember, ["metrics:read"], tenantOp),
    );
    expect(error).toBeInstanceOf(ScopeExceedsIssuerError);
    expect((error as ScopeExceedsIssuerError).operator_only).toEqual(["metrics:read"]);
    const operatorAdmin = {
      kind: "principal" as const,
      principal: userPrincipal(tenantOp, adminOp, ["admin"]),
    };
    expect(
      await outcome(authorizeRetainedScopes(h.db, operatorAdmin, ["metrics:read"], tenantOp)),
    ).toBe("ok");
  });

  test("an issuer outside the operator tenant cannot keep an operator scope on an operator-tenant key", async () => {
    const error = await outcome(
      authorizeRetainedScopes(h.db, member(), ["metrics:read"], tenantOp),
    );
    expect(error).toBeInstanceOf(ScopeExceedsIssuerError);
    expect((error as ScopeExceedsIssuerError).operator_only).toEqual(["metrics:read"]);
  });
});
