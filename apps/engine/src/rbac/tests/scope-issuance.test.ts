import { beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { ALL_PERMISSION_NAMES } from "../catalog.ts";
import { principalHolds } from "../evaluator.ts";
import {
  authorizeRequestedScopes,
  ScopeExceedsIssuerError,
  UnknownScopeError,
} from "../scope-issuance.ts";
import {
  addTenant,
  addUser,
  builtinRole,
  useAccessDb,
  userPrincipal,
} from "./workflow-start-access-fixtures.ts";

const h = useAccessDb("scope_issuance", 20_261_109);

const WILDCARD_REFUSAL =
  "Only a credential without scope limits can issue '*'. List the permissions the key needs instead.";

let tenantA: string;
let tenantOp: string;
let adminA: string;
let memberA: string;
let adminOp: string;

const admin = (extra = {}) => userPrincipal(tenantA, adminA, ["admin"], extra);
const member = (extra = {}) => userPrincipal(tenantA, memberA, ["member"], extra);
const issuer = (principal: ReturnType<typeof admin>) => ({ kind: "principal" as const, principal });

async function refusal(promise: Promise<unknown>): Promise<ScopeExceedsIssuerError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ScopeExceedsIssuerError))
    throw new Error(`expected refusal, got ${String(error)}`);
  return error;
}

beforeAll(async () => {
  tenantA = await addTenant(h, "si-a");
  tenantOp = await addTenant(h, "si-op", true);
  const adminRole = await builtinRole(h, "admin");
  const memberRole = await builtinRole(h, "member");
  adminA = await addUser(h, tenantA, "admin@si", adminRole);
  memberA = await addUser(h, tenantA, "member@si", memberRole);
  adminOp = await addUser(h, tenantOp, "admin@si-op", adminRole);
});

describe("authorizeRequestedScopes for login and system issuers", () => {
  test("a login or system issuer gets the requested scopes unchanged, or '*' when none are asked", async () => {
    expect(await authorizeRequestedScopes(h.db, { kind: "login" }, undefined)).toEqual(["*"]);
    expect(await authorizeRequestedScopes(h.db, { kind: "system" }, undefined)).toEqual(["*"]);
    expect(
      await authorizeRequestedScopes(h.db, { kind: "system" }, ["rbac:write", "rbac:write"]),
    ).toEqual(["rbac:write", "rbac:write"]);
  });
});

describe("authorizeRequestedScopes without a request", () => {
  test("an unbounded issuer issues an unbounded credential", async () => {
    expect(await authorizeRequestedScopes(h.db, issuer(admin()), undefined)).toEqual(["*"]);
    expect(await authorizeRequestedScopes(h.db, issuer(admin({ scopes: [] })), undefined)).toEqual([
      "*",
    ]);
    expect(
      await authorizeRequestedScopes(
        h.db,
        issuer(member({ scopes: ["*", "workflow:read"] })),
        undefined,
      ),
    ).toEqual(["*"]);
  });

  test("a bounded issuer passes on its own scopes when it still holds them", async () => {
    const principal = member({ scopes: ["workflow:read", "workflow:read", "mcp:read"] });
    expect(await authorizeRequestedScopes(h.db, issuer(principal), undefined)).toEqual([
      "workflow:read",
      "mcp:read",
    ]);
  });

  test("a bounded issuer whose role no longer holds an inherited scope is refused", async () => {
    const error = await refusal(
      authorizeRequestedScopes(
        h.db,
        issuer(member({ scopes: ["workflow:read", "rbac:write"] })),
        undefined,
      ),
    );
    expect(error.scopes).toEqual(["rbac:write"]);
    expect(error.operator_only).toEqual([]);
  });

  test("an inherited operator scope outside the operator tenant is skipped, not refused", async () => {
    const principal = member({ scopes: ["workflow:read", "metrics:read"] });
    expect(await authorizeRequestedScopes(h.db, issuer(principal), undefined)).toEqual([
      "workflow:read",
      "metrics:read",
    ]);
  });

  test("a product or portal-token issuer cannot mint an unbounded credential", async () => {
    for (const principal of [
      admin({ product_id: "prod-1" }),
      admin({ provider: "portal_token" }),
    ]) {
      const error = await refusal(authorizeRequestedScopes(h.db, issuer(principal), undefined));
      expect(error.code).toBe("scope_exceeds_issuer");
      expect(error.scopes).toEqual(["*"]);
      expect(error.message).toBe(WILDCARD_REFUSAL);
    }
  });
});

describe("authorizeRequestedScopes with a request", () => {
  test("duplicates collapse to one entry", async () => {
    expect(
      await authorizeRequestedScopes(h.db, issuer(member()), [
        "workflow:read",
        "workflow:run",
        "workflow:read",
      ]),
    ).toEqual(["workflow:read", "workflow:run"]);
  });

  test("an empty request means '*' and is refused for a bounded issuer", async () => {
    expect(await authorizeRequestedScopes(h.db, issuer(admin()), [])).toEqual(["*"]);
    const error = await refusal(
      authorizeRequestedScopes(h.db, issuer(admin({ scopes: ["workflow:read"] })), []),
    );
    expect(error.message).toBe(WILDCARD_REFUSAL);
  });

  test("'*' among other scopes is refused with the wildcard message", async () => {
    const error = await refusal(
      authorizeRequestedScopes(h.db, issuer(member({ scopes: ["workflow:read"] })), [
        "workflow:read",
        "*",
      ]),
    );
    expect(error.scopes).toEqual(["*"]);
    expect(error.message).toBe(WILDCARD_REFUSAL);
  });

  test("unknown scopes are refused before any permission check and named", async () => {
    const caught = await authorizeRequestedScopes(h.db, issuer(admin()), [
      "workflow:read",
      "workflow:fly",
      "nope",
    ]).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(UnknownScopeError);
    const error = caught as UnknownScopeError;
    expect(error.code).toBe("unknown_scope");
    expect(error.scopes).toEqual(["workflow:fly", "nope"]);
    expect(error.message).toBe(
      "Unknown scope(s): workflow:fly, nope. Use permission names from GET /v1/rbac/permissions, '*', or mcp:read, mcp:authoring, mcp:admin.",
    );
  });

  test("a member cannot grant a permission its role lacks", async () => {
    const error = await refusal(
      authorizeRequestedScopes(h.db, issuer(member()), ["workflow:read", "rbac:write"]),
    );
    expect(error.scopes).toEqual(["rbac:write"]);
    expect(error.operator_only).toEqual([]);
    expect(error.message).toBe(
      "You cannot grant rbac:write because your own credential does not hold it. Request only scopes you hold, or ask an admin who holds them.",
    );
  });

  test("a scope-limited admin key cannot grant beyond its own scopes", async () => {
    const error = await refusal(
      authorizeRequestedScopes(h.db, issuer(admin({ scopes: ["workflow:read"] })), [
        "workflow:run",
      ]),
    );
    expect(error.scopes).toEqual(["workflow:run"]);
  });

  test("a scope-limited key grants within its scopes", async () => {
    expect(
      await authorizeRequestedScopes(
        h.db,
        issuer(admin({ scopes: ["workflow:read", "workflow:run"] })),
        ["workflow:run"],
      ),
    ).toEqual(["workflow:run"]);
  });

  test("a bounded issuer grants an MCP mode only when its own credential carries it", async () => {
    const bounded = admin({ scopes: ["workflow:read", "mcp:read"] });
    expect(await authorizeRequestedScopes(h.db, issuer(bounded), ["mcp:read"])).toEqual([
      "mcp:read",
    ]);
    const error = await refusal(authorizeRequestedScopes(h.db, issuer(bounded), ["mcp:admin"]));
    expect(error.scopes).toEqual(["mcp:admin"]);
  });

  test("an unbounded issuer grants an MCP mode only when its role holds it", async () => {
    expect(await authorizeRequestedScopes(h.db, issuer(admin()), ["mcp:admin"])).toEqual([
      "mcp:admin",
    ]);
    expect(await authorizeRequestedScopes(h.db, issuer(member()), ["mcp:read"])).toEqual([
      "mcp:read",
    ]);
    const error = await refusal(authorizeRequestedScopes(h.db, issuer(member()), ["mcp:admin"]));
    expect(error.scopes).toEqual(["mcp:admin"]);
  });

  test("an operator-only scope is refused to an admin outside the operator tenant", async () => {
    const error = await refusal(authorizeRequestedScopes(h.db, issuer(admin()), ["metrics:read"]));
    expect(error.scopes).toEqual(["metrics:read"]);
    expect(error.operator_only).toEqual(["metrics:read"]);
    expect(error.message).toBe(
      "metrics:read affects the whole engine; only the engine operator can grant it.",
    );
  });

  test("a mixed refusal names both the missing and the operator-only scopes", async () => {
    const error = await refusal(
      authorizeRequestedScopes(h.db, issuer(member()), [
        "rbac:write",
        "metrics:read",
        "workflow:read",
      ]),
    );
    expect(error.scopes).toEqual(["rbac:write", "metrics:read"]);
    expect(error.operator_only).toEqual(["metrics:read"]);
    expect(error.message).toBe(
      "You cannot grant rbac:write, metrics:read because your own credential does not hold it. Request only scopes you hold, or ask an admin who holds them. metrics:read affects the whole engine; only the engine operator can grant it.",
    );
  });

  test("several operator-only scopes are listed together in the refusal", async () => {
    const only = await refusal(
      authorizeRequestedScopes(h.db, issuer(admin()), ["metrics:read", "system:restart"]),
    );
    expect(only.message).toBe(
      "metrics:read, system:restart affects the whole engine; only the engine operator can grant it.",
    );
    const mixed = await refusal(
      authorizeRequestedScopes(h.db, issuer(member()), [
        "rbac:write",
        "metrics:read",
        "system:restart",
      ]),
    );
    expect(mixed.message).toBe(
      "You cannot grant rbac:write, metrics:read, system:restart because your own credential does not hold it. Request only scopes you hold, or ask an admin who holds them. metrics:read, system:restart affects the whole engine; only the engine operator can grant it.",
    );
  });

  test("a product caller without own scopes cannot grant an MCP mode", async () => {
    const error = await refusal(
      authorizeRequestedScopes(h.db, issuer(admin({ product_id: "prod-1" })), ["mcp:read"]),
    );
    expect(error.scopes).toEqual(["mcp:read"]);
  });

  test("an admin of the operator tenant grants an operator-only scope", async () => {
    const principal = userPrincipal(tenantOp, adminOp, ["admin"]);
    expect(
      await authorizeRequestedScopes(h.db, issuer(principal), [
        "metrics:read",
        "settings:read:global",
      ]),
    ).toEqual(["metrics:read", "settings:read:global"]);
  });

  test("property: a member never receives a scope it does not hold", async () => {
    const memberHolds = new Set<string>();
    for (const name of ALL_PERMISSION_NAMES) {
      if (await principalHolds(h.db, member(), name)) memberHolds.add(name);
    }
    expect(memberHolds.has("rbac:write")).toBe(false);
    expect(memberHolds.has("workflow:run")).toBe(true);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...ALL_PERMISSION_NAMES), { minLength: 1, maxLength: 6 }),
        async (asked) => {
          const unique = [...new Set(asked)];
          const missing = unique.filter((name) => !memberHolds.has(name));
          const outcome = await authorizeRequestedScopes(h.db, issuer(member()), asked).catch(
            (error: unknown) => error,
          );
          if (missing.length === 0) {
            expect(outcome).toEqual(unique);
          } else {
            expect(outcome).toBeInstanceOf(ScopeExceedsIssuerError);
            expect((outcome as ScopeExceedsIssuerError).scopes).toEqual(missing);
          }
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  }, 60_000);
});
