import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { resourceGrants, systemAccounts } from "../../db/schema/index.ts";
import { getPermissionByName } from "../catalog.ts";
import { assertCan, can } from "../evaluator.ts";
import { BUILTIN_ROLE_NAMES } from "../seed.ts";
import {
  db,
  grantedMember,
  memberB,
  principals,
  tenantA,
  tenantB,
  useRbacMatrixDb,
  workflowAlpha,
  workflowBeta,
} from "./evaluator-matrix-fixtures.ts";

useRbacMatrixDb();

describe("rbac matrix", () => {
  describe("portal_token allowlist", () => {
    function portalToken(
      principalId: string,
      allowed: string[] | "all" | undefined,
    ): ResolvedPrincipal {
      const base: ResolvedPrincipal = {
        provider: "portal_token",
        kind: "user",
        id: principalId,
        tenant_id: tenantA,
        roles: ["enduser"],
      };
      if (allowed !== undefined) base.allowed_workflows = allowed;
      return base;
    }

    test("workflow:run allowed when resource is on the allowlist", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, [workflowAlpha]),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("portal_token_allowlist");
    });

    test("workflow:run denied when resource is off the allowlist", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, [workflowAlpha]),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowBeta },
      });
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("workflow_not_in_allowlist");
    });

    test("allowed='all' grants any workflow:run", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, "all"),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowBeta },
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("portal_token_allowlist");
    });

    test("missing allowed_workflows denies", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, undefined),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
    });

    test("empty allowlist denies workflow:run", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, []),
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
    });

    test("workflow:run requires a workflow resource", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, [workflowAlpha]),
        permission: "workflow:run",
      });
      expect(decision.allow).toBe(false);
    });

    test("conversation:read allows without a resource when allowlist is non-empty", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, [workflowAlpha]),
        permission: "conversation:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("portal_token_allowlist");
    });

    test("conversation:read denied with empty allowlist", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, []),
        permission: "conversation:read",
      });
      expect(decision.allow).toBe(false);
    });

    test("conversation:approve never goes through the allowlist", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, "all"),
        permission: "conversation:approve",
      });
      expect(decision.allow).toBe(false);
    });

    test("portal-token does NOT inherit the underlying user's role", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, "all"),
        permission: "workflow:write",
      });
      expect(decision.allow).toBe(false);
    });

    test("portal-token does NOT inherit a resource grant on the underlying user (security)", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: portalToken(grantedMember.id, "all"),
        permission: "audit:read",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
      expect(decision.source).toBeUndefined();
    });
  });

  describe("tenant boundary", () => {
    test("a tenantB principal cannot satisfy a tenantA-scoped check", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: memberB,
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("a tenantA resource grant does not satisfy a tenantB-scoped check", async () => {
      const decision = await can(db, {
        tenant_id: tenantB,
        principal: grantedMember,
        permission: "audit:read",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
    });
  });

  describe("unknown permission", () => {
    test("denies and tags the reason", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.MEMBER]!,
        permission: "made_up:permission",
      });
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("permission_unknown:made_up:permission");
    });

    test("admin still short-circuits ahead of permission lookup", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.ADMIN]!,
        permission: "made_up:permission",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("builtin_admin");
    });
  });

  describe("catalog lookup", () => {
    test("getPermissionByName returns the catalogue row", () => {
      const row = getPermissionByName("workflow:read");
      expect(row?.resource_type).toBe("workflow");
    });

    test("getPermissionByName returns undefined for unknown names", () => {
      expect(getPermissionByName("does:not:exist")).toBeUndefined();
    });
  });

  describe("assertCan helper", () => {
    test("returns the decision when allowed", async () => {
      const decision = await assertCan(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.MEMBER]!,
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(true);
    });

    test("throws with the deny reason on disallowed checks", async () => {
      await expect(
        assertCan(db, {
          tenant_id: tenantA,
          principal: principals[BUILTIN_ROLE_NAMES.MEMBER]!,
          permission: "rbac:write",
        }),
      ).rejects.toThrow("permission_denied:rbac:write");
    });
  });

  describe("principal.roles fallback", () => {
    test("a user principal without a user row falls back to principal.roles[name]", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: {
          provider: "api_key",
          kind: "user",
          id: "00000000-0000-4000-8000-00000000f00d",
          tenant_id: tenantA,
          roles: [BUILTIN_ROLE_NAMES.MEMBER],
        },
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("system_account with role_id=NULL falls back to principal.roles[name]", async () => {
      const [row] = await db
        .insert(systemAccounts)
        .values({ tenant_id: tenantA, name: "unassigned-sa", role_id: null })
        .returning({ id: systemAccounts.id });
      if (!row) throw new Error("seed sa");
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: {
          provider: "api_key",
          kind: "system_account",
          id: row.id,
          tenant_id: tenantA,
          roles: [BUILTIN_ROLE_NAMES.METRICS_SCRAPER],
        },
        permission: "metrics:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("a user principal without a user row and without roles is denied", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: {
          provider: "api_key",
          kind: "user",
          id: "00000000-0000-4000-8000-00000000f00e",
          tenant_id: tenantA,
          roles: [],
        },
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(false);
    });
  });

  void resourceGrants;
});
