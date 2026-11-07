import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../logging/logger.ts";
import { can, catalogVisibility, principalHolds, resourceAccess } from "../evaluator.ts";
import { grantResource } from "../grants.ts";
import {
  AT,
  addSystemAccount,
  addTenant,
  addUser,
  builtinRole,
  customRole,
  systemPrincipal,
  useAccessDb,
  userPrincipal,
} from "./workflow-start-access-fixtures.ts";

const h = useAccessDb("evaluator_branches", 20_261_112);

const C1 = "c1000000-0000-4000-8000-0000000000c1";
const C2 = "c2000000-0000-4000-8000-0000000000c2";
const W1 = "f1000000-0000-4000-8000-0000000000f1";
const W2 = "f2000000-0000-4000-8000-0000000000f2";
const W3 = "f3000000-0000-4000-8000-0000000000f3";

let tenantA: string;
let tenantB: string;
let roleLessBot: string;
let reviewerBot: string;
let grantee: string;
let adminA: string;
let outsider: string;

async function grant(
  tenant_id: string,
  subject_id: string,
  resource_type: string,
  resource_id: string,
  permission: string,
  expires_at: Date | null = null,
) {
  await grantResource(h.db, {
    tenant_id,
    subject_type: "user",
    subject_id,
    resource_type,
    resource_id,
    permission,
    expires_at,
  });
}

beforeAll(async () => {
  tenantA = await addTenant(h, "eb-a");
  tenantB = await addTenant(h, "eb-b");
  const reviewer = await customRole(h, tenantA, "reviewer", ["workflow:read"]);
  const emptyA = await customRole(h, tenantA, "empty", []);
  const emptyB = await customRole(h, tenantB, "empty", []);
  roleLessBot = await addSystemAccount(h, tenantA, "roleless", null);
  reviewerBot = await addSystemAccount(h, tenantA, "reviewer-bot", reviewer);
  grantee = await addUser(h, tenantA, "grantee@eb", emptyA);
  adminA = await addUser(h, tenantA, "admin@eb", await builtinRole(h, "admin"));
  outsider = await addUser(h, tenantB, "outsider@eb", emptyB);
  await grant(tenantA, grantee, "connector", C1, "connector:read");
  await grant(tenantA, grantee, "connector", C2, "connector:read");
  await grant(tenantA, grantee, "workflow", W1, "workflow:read");
  await grant(tenantA, grantee, "workflow", W2, "workflow:read", AT);
  await grant(tenantB, outsider, "workflow", W3, "workflow:read");
});

describe("system account role resolution", () => {
  test("a system account without a stored role falls back to the builtin role it was resolved with", async () => {
    const decision = await can(h.db, {
      tenant_id: tenantA,
      principal: systemPrincipal(tenantA, roleLessBot, ["member"]),
      permission: "workflow:run",
    });
    expect(decision).toEqual({ allow: true, source: "role" });
  });

  test("a system account without a stored role and no known role name is denied", async () => {
    for (const roles of [["no-such-role"], []]) {
      const decision = await can(h.db, {
        tenant_id: tenantA,
        principal: systemPrincipal(tenantA, roleLessBot, roles),
        permission: "workflow:run",
        quiet: true,
      });
      expect(decision).toEqual({
        allow: false,
        reason: "permission_denied:workflow:run",
        detail: { required: "workflow:run", cause: "no_matching_grant" },
      });
    }
  });

  test("a stored role wins over a broader role name claimed on the principal", async () => {
    const principal = systemPrincipal(tenantA, reviewerBot, ["member"]);
    expect(
      (await can(h.db, { tenant_id: tenantA, principal, permission: "workflow:read" })).allow,
    ).toBe(true);
    const run = await can(h.db, {
      tenant_id: tenantA,
      principal,
      permission: "workflow:run",
      quiet: true,
    });
    expect(run.allow).toBe(false);
  });
});

describe("principals without a stored record", () => {
  test("an unknown user or system account resolves the first known builtin role name", async () => {
    for (const principal of [
      userPrincipal(tenantA, h.nextId(), ["no-such-role", "member"]),
      systemPrincipal(tenantA, h.nextId(), ["no-such-role", "member"]),
    ]) {
      expect(
        await can(h.db, { tenant_id: tenantA, principal, permission: "workflow:run" }),
      ).toEqual({ allow: true, source: "role" });
    }
  });

  test("an unknown user or system account with only unknown role names holds nothing", async () => {
    for (const principal of [
      userPrincipal(tenantA, h.nextId(), ["no-such-role"]),
      systemPrincipal(tenantA, h.nextId(), ["no-such-role"]),
    ]) {
      const decision = await can(h.db, {
        tenant_id: tenantA,
        principal,
        permission: "workflow:run",
        quiet: true,
      });
      expect(decision.allow).toBe(false);
    }
  });
});

describe("resourceAccess for connectors", () => {
  test("a connector allowlist narrows resource grants to the listed connectors", async () => {
    const access = await resourceAccess(h.db, {
      tenant_id: tenantA,
      principal: userPrincipal(tenantA, grantee, ["empty"], { allowed_connectors: [C1] }),
      permission: "connector:read",
      resource_type: "connector",
      quiet: true,
    });
    expect(access.tenantWide.allow).toBe(false);
    expect(access.any).toBe(true);
    expect(access.allows(C1)).toBe(true);
    expect(access.allows(C2)).toBe(false);
  });

  test("a connector allowlist narrows a tenant-wide admin too", async () => {
    const access = await resourceAccess(h.db, {
      tenant_id: tenantA,
      principal: userPrincipal(tenantA, adminA, ["admin"], { allowed_connectors: [C1] }),
      permission: "connector:read",
      resource_type: "connector",
    });
    expect(access.tenantWide).toEqual({ allow: true, source: "builtin_admin" });
    expect([access.allows(C1), access.allows(C2)]).toEqual([true, false]);
  });

  test("the allowlist 'all' leaves every connector reachable", async () => {
    const access = await resourceAccess(h.db, {
      tenant_id: tenantA,
      principal: userPrincipal(tenantA, adminA, ["admin"], { allowed_connectors: "all" }),
      permission: "connector:read",
      resource_type: "connector",
    });
    expect([access.allows(C1), access.allows(C2)]).toEqual([true, true]);
  });

  test("a resource type without an allowlist ignores the workflow and connector lists", async () => {
    const access = await resourceAccess(h.db, {
      tenant_id: tenantA,
      principal: userPrincipal(tenantA, adminA, ["admin"], {
        allowed_connectors: [C1],
        allowed_workflows: [W1],
      }),
      permission: "knowledge:read",
      resource_type: "knowledge_source",
    });
    expect(access.allows(C2)).toBe(true);
    expect(access.allows(W2)).toBe(true);
  });
});

describe("catalogVisibility", () => {
  test("a principal without any access sees no catalog", async () => {
    expect(
      await catalogVisibility(
        h.db,
        userPrincipal(tenantA, roleLessBot, []),
        "workflow:read",
        "workflow",
      ),
    ).toBeNull();
  });

  test("grants alone show exactly the granted, unexpired entries", async () => {
    const visible = await catalogVisibility(
      h.db,
      userPrincipal(tenantA, grantee, ["empty"]),
      "workflow:read",
      "workflow",
    );
    if (!visible) throw new Error("expected a visibility filter");
    expect([W1, W2, W3].map(visible)).toEqual([true, false, false]);
  });

  test("another tenant's grant gives no catalog in this tenant", async () => {
    expect(
      await catalogVisibility(
        h.db,
        userPrincipal(tenantA, outsider, []),
        "workflow:read",
        "workflow",
      ),
    ).toBeNull();
  });

  test("a tenant-wide reader sees every entry", async () => {
    const visible = await catalogVisibility(
      h.db,
      userPrincipal(tenantA, adminA, ["admin"]),
      "workflow:read",
      "workflow",
    );
    expect(visible?.(W3)).toBe(true);
  });

  test("a portal token sees only its allowlisted workflows, and nothing with an empty list", async () => {
    const portal = (allowed: string[]) =>
      userPrincipal(tenantA, grantee, [], { provider: "portal_token", allowed_workflows: allowed });
    const visible = await catalogVisibility(h.db, portal([W2]), "workflow:read", "workflow");
    expect([W1, W2].map((id) => visible?.(id))).toEqual([false, true]);
    expect(await catalogVisibility(h.db, portal([]), "workflow:read", "workflow")).toBeNull();
  });

  test("a credential ceiling hides the whole catalog", async () => {
    expect(
      await catalogVisibility(
        h.db,
        userPrincipal(tenantA, adminA, ["admin"], { scopes: ["execution:read"] }),
        "workflow:read",
        "workflow",
      ),
    ).toBeNull();
  });
});

describe("principalHolds", () => {
  test("answers whether the principal holds the permission tenant-wide, without a WARN log", async () => {
    const warn = spyOn(logger, "warn");
    try {
      expect(
        await principalHolds(h.db, systemPrincipal(tenantA, reviewerBot, []), "workflow:read"),
      ).toBe(true);
      expect(
        await principalHolds(h.db, systemPrincipal(tenantA, reviewerBot, []), "workflow:run"),
      ).toBe(false);
      expect(
        await principalHolds(h.db, userPrincipal(tenantA, grantee, ["empty"]), "workflow:read"),
      ).toBe(false);
      expect(
        warn.mock.calls.filter((call) => (call[0] as { action?: string })?.action === "denied"),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("a principal never borrows the stored role of a same-id user in another tenant", async () => {
    expect(await principalHolds(h.db, userPrincipal(tenantB, adminA, []), "workflow:read")).toBe(
      false,
    );
  });
});
