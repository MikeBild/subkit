import { describe, expect, test } from "bun:test";
import { isCeilingScope } from "../../auth/scopes.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  ALL_PERMISSION_NAMES,
  isOperatorPermission,
  loadPermissionCatalog,
  OPERATOR_PERMISSIONS,
} from "../catalog.ts";
import { can } from "../evaluator.ts";
import * as grantsSvc from "../grants.ts";
import { BUILTIN_ROLE_NAMES } from "../seed.ts";
import {
  db,
  grantedMember,
  groupMember,
  principals,
  tenantA,
  tenantB,
  useRbacMatrixDb,
  workflowAlpha,
  workflowBeta,
} from "./evaluator-matrix-fixtures.ts";

const ENDUSER_PERMISSIONS = new Set<string>([
  "workflow:read",
  "workflow:run",
  "execution:read",
  "conversation:read",
  "conversation:write",
  "conversation:cancel",
  "conversation:list",
  "knowledge:read",
  "skill:read",
  "file:read",
  "local:confirm",
]);

const METRICS_SCRAPER_PERMISSIONS = new Set<string>(["metrics:read"]);

const PORTAL_TOKEN_USER_PERMISSIONS = new Set<string>([
  "workflow:read",
  "workflow:run",
  "conversation:read",
  "conversation:write",
  "conversation:cancel",
]);

function memberAllows(name: string): boolean {
  if (isOperatorPermission(name)) return false;
  if (name.startsWith("rbac:")) return false;
  if (name === "audit:read") return false;
  if (name === "identity:write") return false;
  if (name === "api_key:write") return false;
  if (name === "api_key:rotate") return false;
  if (name === "api_key:revoke") return false;
  if (name === "connector:promote") return false;
  if (name === "connector:confirm_local_command") return false;
  if (name.startsWith("vault:") && name !== "vault:read" && name !== "vault:use") return false;
  if (name === "discovery:approve") return false;
  if (name === "stats:read") return false;
  if (name === "stats:read:all") return false;
  if (name.startsWith("self_healing:")) return false;
  if (name === "mcp:admin") return false;
  if (name.startsWith("mcp_oauth_client:")) return false;
  if (name === "system:restart") return false;
  if (name === "device:revoke_any") return false;
  if (name.startsWith("chat_workspace:") && name !== "chat_workspace:read") return false;
  if (name.startsWith("chat_identity:") && name !== "chat_identity:read") return false;
  return true;
}

function expectedAllow(roleName: string, permission: string): boolean {
  switch (roleName) {
    case BUILTIN_ROLE_NAMES.ADMIN:
      return true;
    case BUILTIN_ROLE_NAMES.MEMBER:
      return memberAllows(permission);
    case BUILTIN_ROLE_NAMES.ENDUSER:
      return ENDUSER_PERMISSIONS.has(permission);
    case BUILTIN_ROLE_NAMES.METRICS_SCRAPER:
      return METRICS_SCRAPER_PERMISSIONS.has(permission);
    case BUILTIN_ROLE_NAMES.PORTAL_TOKEN_USER:
      return PORTAL_TOKEN_USER_PERMISSIONS.has(permission);
    default:
      throw new Error(`unknown role ${roleName}`);
  }
}

useRbacMatrixDb();

describe("rbac matrix", () => {
  describe("role × permission catalogue", () => {
    test("the catalogue is what we think it is", () => {
      expect(ALL_PERMISSION_NAMES.length).toBe(loadPermissionCatalog().length);
      expect(ALL_PERMISSION_NAMES.length).toBeGreaterThanOrEqual(60);
    });

    for (const roleName of Object.values(BUILTIN_ROLE_NAMES)) {
      describe(`role=${roleName}`, () => {
        test(`every permission resolves to its expected allow/deny (${roleName})`, async () => {
          const principal = principals[roleName];
          if (!principal) throw new Error(`no principal for ${roleName}`);
          for (const permission of ALL_PERMISSION_NAMES) {
            const decision = await can(db, {
              tenant_id: tenantA,
              principal,
              permission,
            });
            const expected = expectedAllow(roleName, permission);
            if (decision.allow !== expected) {
              throw new Error(
                `RBAC matrix mismatch: role=${roleName} permission=${permission} expected_allow=${expected} got_allow=${decision.allow} reason=${decision.reason ?? "n/a"}`,
              );
            }
            expect(decision.allow).toBe(expected);
            if (decision.allow) {
              expect(decision.source).toBeDefined();
            } else {
              expect(decision.reason).toBeDefined();
              expect(decision.reason).toContain(
                isOperatorPermission(permission) && principal.provider === "portal_token"
                  ? "operator_boundary"
                  : "permission_denied",
              );
            }
          }
        });
      });
    }
  });

  describe("operator boundary", () => {
    test("an admin of a non-operator tenant is denied every operator permission and nothing else", async () => {
      const principal: ResolvedPrincipal = {
        provider: "api_key",
        kind: "user",
        id: "00000000-0000-4000-8000-0000000b0a0d",
        tenant_id: tenantB,
        roles: [BUILTIN_ROLE_NAMES.ADMIN],
      };
      for (const permission of ALL_PERMISSION_NAMES) {
        const decision = await can(db, { tenant_id: tenantB, principal, permission });
        expect({ permission, allow: decision.allow }).toEqual({
          permission,
          allow: !isOperatorPermission(permission),
        });
        if (!decision.allow) {
          expect(decision.source).toBe("operator_boundary");
          expect(decision.detail?.cause).toBe("operator_only");
        }
      }
    });

    test("the operator permissions are exactly the engine-wide ones", () => {
      expect([...OPERATOR_PERMISSIONS].sort()).toEqual([
        "mcp_oauth_client:disable",
        "metrics:read",
        "settings:read:global",
        "settings:write:global",
        "system:restart",
      ]);
    });
  });

  describe("scoped-key persona", () => {
    test("an API-key ceiling contains every catalog permission outside its explicit scopes", async () => {
      const scopes = ["intake:read", "workflow:run"];
      const principal: ResolvedPrincipal = {
        ...principals[BUILTIN_ROLE_NAMES.ADMIN]!,
        scopes,
      };

      for (const permission of ALL_PERMISSION_NAMES.filter(isCeilingScope)) {
        const decision = await can(db, {
          tenant_id: tenantA,
          principal,
          permission,
        });
        expect(decision.allow).toBe(scopes.includes(permission));
        if (!scopes.includes(permission)) {
          expect(decision.reason).toBe(`credential_ceiling:scope_not_granted`);
        }
      }
    });
  });

  describe("decision sources", () => {
    test("admin always uses the builtin_admin short-circuit", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.ADMIN]!,
        permission: "rbac:write",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("builtin_admin");
    });

    test("non-admin allows are attributed to role", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.MEMBER]!,
        permission: "workflow:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("system account allows are attributed to role", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: principals[BUILTIN_ROLE_NAMES.METRICS_SCRAPER]!,
        permission: "metrics:read",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("role");
    });

    test("group membership grants admin via the group path", async () => {
      const decision = await can(db, {
        tenant_id: tenantA,
        principal: groupMember,
        permission: "rbac:write",
      });
      expect(decision.allow).toBe(true);
      expect(decision.source).toBe("group");
    });
  });

  describe("resource-scoped grants", () => {
    test("grant allows only on the granted resource", async () => {
      const onTarget = await can(db, {
        tenant_id: tenantA,
        principal: grantedMember,
        permission: "audit:read",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(onTarget.allow).toBe(true);
      expect(onTarget.source).toBe("resource_grant");

      const offTarget = await can(db, {
        tenant_id: tenantA,
        principal: grantedMember,
        permission: "audit:read",
        resource: { type: "workflow", id: workflowBeta },
      });
      expect(offTarget.allow).toBe(false);
    });

    test("grant does not bypass tenant boundary", async () => {
      const decision = await can(db, {
        tenant_id: tenantB,
        principal: grantedMember,
        permission: "audit:read",
        resource: { type: "workflow", id: workflowAlpha },
      });
      expect(decision.allow).toBe(false);
    });

    test("grant on system_account subject works the same way", async () => {
      const metricsAcct = principals[BUILTIN_ROLE_NAMES.METRICS_SCRAPER]!;
      await grantsSvc.grantResource(db, {
        tenant_id: tenantA,
        subject_type: "system_account",
        subject_id: metricsAcct.id,
        resource_type: "workflow",
        resource_id: workflowBeta,
        permission: "workflow:run",
      });
      const onTarget = await can(db, {
        tenant_id: tenantA,
        principal: metricsAcct,
        permission: "workflow:run",
        resource: { type: "workflow", id: workflowBeta },
      });
      expect(onTarget.allow).toBe(true);
      expect(onTarget.source).toBe("resource_grant");
    });
  });
});
