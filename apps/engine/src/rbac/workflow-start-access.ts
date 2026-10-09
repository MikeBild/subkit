import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { permissions, resourceGrants, rolePermissions, roles } from "../db/schema/index.ts";
import { can } from "./evaluator.ts";

type WorkflowStartGrant = {
  subject_type: "user" | "system_account" | "group";
  subject_id: string;
  expires_at: string | null;
};

export async function workflowStartAccess(
  db: Db,
  principal: ResolvedPrincipal,
  workflowId: string,
  at: Date,
) {
  const tenantId = principal.tenant_id;
  const [caller, rulesVisibility] = await Promise.all([
    can(db, {
      tenant_id: tenantId,
      principal,
      permission: "workflow:run",
      resource: { type: "workflow", id: workflowId },
      quiet: true,
    }),
    can(db, { tenant_id: tenantId, principal, permission: "rbac:read", quiet: true }),
  ]);
  const rules = rulesVisibility.allow
    ? await Promise.all([
        db
          .selectDistinct({ id: roles.id, name: roles.name })
          .from(roles)
          .leftJoin(rolePermissions, eq(rolePermissions.role_id, roles.id))
          .leftJoin(permissions, eq(permissions.id, rolePermissions.permission_id))
          .where(
            and(
              or(isNull(roles.tenant_id), eq(roles.tenant_id, tenantId)),
              or(eq(roles.name, "admin"), eq(permissions.name, "workflow:run")),
            ),
          ),
        db
          .select({
            subject_type: resourceGrants.subject_type,
            subject_id: resourceGrants.subject_id,
            expires_at: resourceGrants.expires_at,
          })
          .from(resourceGrants)
          .innerJoin(permissions, eq(permissions.id, resourceGrants.permission_id))
          .where(
            and(
              eq(resourceGrants.tenant_id, tenantId),
              eq(resourceGrants.resource_type, "workflow"),
              eq(resourceGrants.resource_id, workflowId),
              eq(permissions.name, "workflow:run"),
              or(isNull(resourceGrants.expires_at), gt(resourceGrants.expires_at, at)),
            ),
          ),
      ])
    : null;
  return {
    permission: "workflow:run" as const,
    caller: { allowed: caller.allow, source: caller.source ?? null, reason: caller.reason ?? null },
    visibility: { rules: rulesVisibility.allow },
    ...(rules
      ? {
          rules: {
            roles: rules[0].sort(
              (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
            ),
            grants: rules[1]
              .flatMap<WorkflowStartGrant>((grant) => {
                const subject_type = grant.subject_type;
                if (
                  subject_type !== "user" &&
                  subject_type !== "system_account" &&
                  subject_type !== "group"
                )
                  return [];
                return [
                  {
                    subject_type,
                    subject_id: grant.subject_id,
                    expires_at: grant.expires_at?.toISOString() ?? null,
                  },
                ];
              })
              .sort(
                (a, b) =>
                  a.subject_type.localeCompare(b.subject_type) ||
                  a.subject_id.localeCompare(b.subject_id),
              ),
          },
        }
      : {}),
    external: {
      authentication_required: true as const,
      credential_restrictions_apply: true as const,
    },
    without_approval: "held_preview_only" as const,
  };
}
