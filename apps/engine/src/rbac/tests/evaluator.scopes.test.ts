import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  permissions as permissionsTable,
  rolePermissions,
  systemAccounts,
} from "../../db/schema/index.ts";
import { can, connectorAccessLevel } from "../evaluator.ts";
import {
  adminUserId,
  connectorReadId,
  connectorRWId,
  db,
  groupGrantUserId,
  memberUserId,
  mkPrincipal,
  noRoleUserId,
  tenantId,
  useRbacEvaluatorDb,
  workflowA,
  workflowB,
} from "./evaluator-fixtures.ts";

const connectorNoneId = "55555555-5555-5555-5555-555555555555";

useRbacEvaluatorDb();

function adminWith(extra: Partial<ResolvedPrincipal>): ResolvedPrincipal {
  return { ...mkPrincipal(adminUserId, "admin"), ...extra };
}

describe("rbac evaluator", () => {
  test("wildcard scope ['*'] does not narrow the admin key", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ scopes: ["*"] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("builtin_admin");
  });

  test("a resource:action scope ceiling narrows even an admin", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ scopes: ["workflow:read"] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(false);
    expect(d.source).toBe("credential_ceiling");
    expect(d.reason).toBe("credential_ceiling:scope_not_granted");
  });

  test("a scope within the ceiling is allowed", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ scopes: ["connector:write"] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(true);
  });

  test("mcp:* marker-only scopes do not narrow", async () => {
    for (const markers of [["mcp:authoring"], ["mcp:read"], ["mcp:admin"]]) {
      const d = await can(db, {
        tenant_id: tenantId,
        principal: adminWith({ scopes: markers }),
        permission: "connector:write",
        resource: { type: "connector", id: connectorNoneId },
      });
      expect(d.allow).toBe(true);
    }
  });

  test("allowed_connectors ceiling denies a connector outside the list — even for admin", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_connectors: [connectorReadId] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("credential_ceiling:connector_not_in_allowlist");
  });

  test("allowed_connectors ceiling allows a connector in the list", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_connectors: [connectorReadId] }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorReadId },
    });
    expect(d.allow).toBe(true);
  });

  test("allowed_workflows ceiling denies a workflow outside the list", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_workflows: [workflowA] }),
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("credential_ceiling:workflow_not_in_allowlist");
  });

  test("absent credential fields are a no-op", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "workflow:read",
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("role");
  });

  test("a system_account credential is also narrowed by a scope ceiling", async () => {
    const principal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "system_account",
      id: adminUserId,
      tenant_id: tenantId,
      roles: ["admin"],
      scopes: ["workflow:read"],
    };
    const d = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(false);
    expect(d.source).toBe("credential_ceiling");
  });

  test("a mixed scope set (mcp marker + one permission) narrows to that permission", async () => {
    const principal = adminWith({ scopes: ["mcp:authoring", "workflow:read"] });
    const allowed = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "workflow:read",
      resource: { type: "workflow", id: workflowA },
    });
    expect(allowed.allow).toBe(true);
    const denied = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe("credential_ceiling:scope_not_granted");
  });

  test('allowed_connectors "all" imposes no ceiling', async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_connectors: "all" }),
      permission: "connector:write",
      resource: { type: "connector", id: connectorNoneId },
    });
    expect(d.allow).toBe(true);
  });

  test('allowed_workflows "all" imposes no ceiling', async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_workflows: "all" }),
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(true);
  });

  test("allowed_connectors ceiling does not affect non-connector resources", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: adminWith({ allowed_connectors: [connectorReadId] }),
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(true);
  });

  test("a group-subject grant does not leak to a non-member", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowA },
    });
    expect(d.allow).toBe(false);
  });

  test("an expired group-subject grant does not allow", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(groupGrantUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(false);
  });

  test("deny carries actionable detail", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "audit:read",
    });
    expect(d.allow).toBe(false);
    expect(d.detail?.required).toBe("audit:read");
    expect(d.detail?.cause).toBe("no_matching_grant");
  });

  test("connectorAccessLevel reflects grants", async () => {
    const principal: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: noRoleUserId,
      tenant_id: tenantId,
      roles: [],
    };
    expect(await connectorAccessLevel(db, principal, connectorRWId, tenantId)).toBe("read-write");
    expect(await connectorAccessLevel(db, principal, connectorReadId, tenantId)).toBe("read-only");
    expect(await connectorAccessLevel(db, principal, connectorNoneId, tenantId)).toBe("none");
  });

  test("connectorAccessLevel is read-write for admin", async () => {
    const level = await connectorAccessLevel(
      db,
      mkPrincipal(adminUserId, "admin"),
      connectorNoneId,
      tenantId,
    );
    expect(level).toBe("read-write");
  });

  void permissionsTable;

  void rolePermissions;

  void systemAccounts;

  void workflowA;
});
