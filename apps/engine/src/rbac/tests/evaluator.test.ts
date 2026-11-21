import { describe, expect, spyOn, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { logger } from "../../logging/index.ts";
import { can } from "../evaluator.ts";
import {
  adminUserId,
  db,
  expiryUserId,
  groupGrantUserId,
  groupUserId,
  memberUserId,
  mkPrincipal,
  resourceGrantUserId,
  tenantId,
  useRbacEvaluatorDb,
  workflowA,
  workflowB,
  workflowFuture,
} from "./evaluator-fixtures.ts";

useRbacEvaluatorDb();

describe("rbac evaluator", () => {
  test("builtin_admin short-circuits", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(adminUserId, "admin"),
      permission: "workflow:delete",
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("builtin_admin");
  });

  test("role permission grants access", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "workflow:read",
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("role");
  });

  test("role denies when permission not in role_permissions", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "audit:read",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("permission_denied");
  });

  test("resource_grant path grants access on target", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(resourceGrantUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowA },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("resource_grant");
  });

  test("a wildcard resource id is evaluated without querying the uuid grant column", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "connector:read",
      resource: { type: "connector", id: "*" },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("role");
  });

  test("resource_grant does not leak to other resources", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(resourceGrantUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(false);
  });

  test("group membership grants access via admin role assignment", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(groupUserId, "member"),
      permission: "workflow:delete",
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("group");
  });

  test("portal_token allowlist allows workflow:run when included", async () => {
    const principal: ResolvedPrincipal = {
      provider: "portal_token",
      kind: "user",
      id: resourceGrantUserId,
      tenant_id: tenantId,
      roles: ["enduser"],
      allowed_workflows: [workflowB],
    };
    const d = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("portal_token_allowlist");
  });

  test("portal_token outside allowlist is denied", async () => {
    const principal: ResolvedPrincipal = {
      provider: "portal_token",
      kind: "user",
      id: resourceGrantUserId,
      tenant_id: tenantId,
      roles: ["enduser"],
      allowed_workflows: [workflowB],
    };
    const d = await can(db, {
      tenant_id: tenantId,
      principal,
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowA },
    });
    expect(d.allow).toBe(false);
  });

  test("unknown permission is denied", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(memberUserId, "member"),
      permission: "something:nonexistent",
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("permission_unknown");
  });

  test("a genuine deny WARN-logs (rbac.denied)", async () => {
    const warnSpy = spyOn(logger, "warn");
    const debugSpy = spyOn(logger, "debug");
    try {
      const d = await can(db, {
        tenant_id: tenantId,
        principal: mkPrincipal(memberUserId, "member"),
        permission: "audit:read",
      });
      expect(d.allow).toBe(false);
      const denyWarn = warnSpy.mock.calls.find(
        (c) => (c[0] as { module?: string; action?: string })?.action === "denied",
      );
      expect(denyWarn).toBeDefined();
      const checkedDebug = debugSpy.mock.calls.find(
        (c) => (c[0] as { module?: string; action?: string })?.action === "checked",
      );
      expect(checkedDebug).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  test("a quiet deny logs at DEBUG (rbac.checked), never WARN", async () => {
    const warnSpy = spyOn(logger, "warn");
    const debugSpy = spyOn(logger, "debug");
    try {
      const d = await can(db, {
        tenant_id: tenantId,
        principal: mkPrincipal(memberUserId, "member"),
        permission: "audit:read",
        quiet: true,
      });
      expect(d.allow).toBe(false);
      const denyWarn = warnSpy.mock.calls.find(
        (c) => (c[0] as { module?: string; action?: string })?.action === "denied",
      );
      expect(denyWarn).toBeUndefined();
      const checkedDebug = debugSpy.mock.calls.find(
        (c) =>
          (c[0] as { action?: string; allow?: boolean })?.action === "checked" &&
          (c[0] as { allow?: boolean })?.allow === false,
      );
      expect(checkedDebug).toBeDefined();
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  test("group-subject resource grant resolves for a member", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(groupGrantUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowA },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("resource_grant");
  });

  test("expired resource grant does not allow", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(expiryUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowB },
    });
    expect(d.allow).toBe(false);
  });

  test("future (unexpired) resource grant allows", async () => {
    const d = await can(db, {
      tenant_id: tenantId,
      principal: mkPrincipal(expiryUserId, "member"),
      permission: "audit:read",
      resource: { type: "workflow", id: workflowFuture },
    });
    expect(d.allow).toBe(true);
    expect(d.source).toBe("resource_grant");
  });
});
