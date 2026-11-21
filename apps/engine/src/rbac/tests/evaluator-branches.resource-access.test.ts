import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../logging/index.ts";
import { can, catalogVisibility, resourceAccess } from "../evaluator.ts";
import { grantResource } from "../grants.ts";
import {
  addGroup,
  addSystemAccount,
  addTenant,
  addUser,
  customRole,
  systemPrincipal,
  useAccessDb,
  userPrincipal,
} from "./workflow-start-access-fixtures.ts";

const h = useAccessDb("evaluator_resource_access", 20_261_113);

const W1 = "e1000000-0000-4000-8000-0000000000e1";
const W2 = "e2000000-0000-4000-8000-0000000000e2";
const W3 = "e3000000-0000-4000-8000-0000000000e3";

let tenantA: string;
let grantee: string;
let groupMember: string;
let bot: string;

async function grant(
  subject_type: "user" | "system_account" | "group",
  subject_id: string,
  resource_id: string,
  permission: string,
) {
  await grantResource(h.db, {
    tenant_id: tenantA,
    subject_type,
    subject_id,
    resource_type: "workflow",
    resource_id,
    permission,
  });
}

const access = (principal: ReturnType<typeof userPrincipal>, permission = "workflow:read") =>
  resourceAccess(h.db, {
    tenant_id: tenantA,
    principal,
    permission,
    resource_type: "workflow",
    quiet: true,
  });

beforeAll(async () => {
  tenantA = await addTenant(h, "ra-a");
  const empty = await customRole(h, tenantA, "empty", []);
  grantee = await addUser(h, tenantA, "grantee@ra", empty);
  groupMember = await addUser(h, tenantA, "member@ra", empty);
  bot = await addSystemAccount(h, tenantA, "bot", empty);
  const group = await addGroup(h, tenantA, "readers", [], [groupMember]);
  await grant("user", grantee, W1, "workflow:read");
  await grant("user", grantee, W1, "metrics:read");
  await grant("group", group, W2, "workflow:read");
  await grant("system_account", bot, W3, "workflow:read");
});

describe("resourceAccess grant collection", () => {
  test("a user reaches exactly its granted workflows", async () => {
    const result = await access(userPrincipal(tenantA, grantee, ["empty"]));
    expect(result.any).toBe(true);
    expect([W1, W2, W3].map(result.allows)).toEqual([true, false, false]);
  });

  test("a group grant reaches the group's members", async () => {
    const result = await access(userPrincipal(tenantA, groupMember, ["empty"]));
    expect([W1, W2, W3].map(result.allows)).toEqual([false, true, false]);
  });

  test("a system account reaches its own grants and no group grants", async () => {
    const result = await access(systemPrincipal(tenantA, bot, ["empty"]));
    expect([W1, W2, W3].map(result.allows)).toEqual([false, false, true]);
  });

  test("a user with no grants reaches nothing", async () => {
    const result = await access(userPrincipal(tenantA, h.nextId(), []));
    expect(result.any).toBe(false);
    expect(result.allows(W1)).toBe(false);
  });

  test("an unknown permission reaches nothing and does not throw", async () => {
    const result = await access(userPrincipal(tenantA, grantee, ["empty"]), "workflow:fly");
    expect(result.any).toBe(false);
    expect(result.allows(W1)).toBe(false);
  });

  test("a workflow allowlist narrows the grants of a non-admin", async () => {
    const result = await access(
      userPrincipal(tenantA, grantee, ["empty"], { allowed_workflows: [W3] }),
    );
    expect(result.allows(W1)).toBe(false);
  });
});

describe("resourceAccess hard stops", () => {
  test("a scope ceiling that excludes the permission disables every grant", async () => {
    const result = await access(
      userPrincipal(tenantA, grantee, ["empty"], { scopes: ["execution:read"] }),
    );
    expect(result.tenantWide.source).toBe("credential_ceiling");
    expect(result.any).toBe(false);
    expect(result.allows(W1)).toBe(false);
  });

  test("an operator-only permission outside the operator tenant disables its resource grants", async () => {
    const result = await access(userPrincipal(tenantA, grantee, ["empty"]), "metrics:read");
    expect(result.tenantWide.source).toBe("operator_boundary");
    expect(result.any).toBe(false);
    expect(result.allows(W1)).toBe(false);
  });
});

describe("resourceAccess for portal tokens", () => {
  const portal = (allowed: string[] | "all") =>
    userPrincipal(tenantA, grantee, [], { provider: "portal_token", allowed_workflows: allowed });

  test("a portal token ignores resource grants and follows its allowlist", async () => {
    const result = await access(portal([W2]));
    expect(result.any).toBe(true);
    expect([W1, W2].map(result.allows)).toEqual([false, true]);
  });

  test("a portal token with 'all' reaches every workflow for read and run", async () => {
    for (const permission of ["workflow:read", "workflow:run"]) {
      const result = await access(portal("all"), permission);
      expect(result.any).toBe(true);
      expect(result.allows(W3)).toBe(true);
    }
  });

  test("a portal token reaches no workflow for another permission", async () => {
    const result = await access(portal("all"), "execution:read");
    expect(result.any).toBe(false);
  });

  test("a portal token reaches no workflow-like entry of another resource type", async () => {
    const result = await resourceAccess(h.db, {
      tenant_id: tenantA,
      principal: portal("all"),
      permission: "workflow:read",
      resource_type: "connector",
      quiet: true,
    });
    expect(result.any).toBe(false);
  });
});

describe("deny logging", () => {
  test("a catalog lookup without access logs no WARN deny", async () => {
    const warn = spyOn(logger, "warn");
    try {
      await catalogVisibility(
        h.db,
        userPrincipal(tenantA, h.nextId(), []),
        "workflow:read",
        "workflow",
      );
      expect(
        warn.mock.calls.filter((call) => (call[0] as { action?: string })?.action === "denied"),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("a quiet deny logs the reason as a debug check, a loud deny warns with the reason", async () => {
    const warn = spyOn(logger, "warn");
    const debug = spyOn(logger, "debug");
    try {
      const principal = userPrincipal(tenantA, grantee, ["empty"]);
      await can(h.db, { tenant_id: tenantA, principal, permission: "rbac:write", quiet: true });
      const checked = debug.mock.calls
        .map(
          (call) =>
            call[0] as { action?: string; allow?: boolean; reason?: string; source?: string },
        )
        .find((fields) => fields?.action === "checked");
      expect(checked).toMatchObject({
        allow: false,
        reason: "permission_denied:rbac:write",
        source: "none",
      });
      expect(
        warn.mock.calls.filter((call) => (call[0] as { action?: string })?.action === "denied"),
      ).toHaveLength(0);
      await can(h.db, { tenant_id: tenantA, principal, permission: "rbac:write" });
      const denied = warn.mock.calls
        .map((call) => call[0] as { action?: string; reason?: string; source?: string })
        .find((fields) => fields?.action === "denied");
      expect(denied).toMatchObject({ reason: "permission_denied:rbac:write", source: "none" });
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });
});
