import type { Context, MiddlewareHandler } from "hono";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { captureWorkflowPermission } from "../../execution/index.ts";
import { denialDetails, denialHint } from "../../rbac/denial.ts";
import {
  type ConnectorAccessLevel,
  can,
  connectorAccessLevel,
  type Decision,
} from "../../rbac/evaluator.ts";
import { HttpError, UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

type ResourceFromFn = (c: Context<AppEnv>) => { type: string; id: string } | undefined;

async function forbiddenFor(
  db: Db,
  principal: ResolvedPrincipal,
  decision: Decision,
  resource: { type: string; id: string } | undefined,
  fallbackReason: string,
): Promise<HttpError> {
  let level: ConnectorAccessLevel | undefined;
  if (resource?.type === "connector") {
    level = await connectorAccessLevel(db, principal, resource.id, principal.tenant_id);
  }
  const reason = decision.reason ?? fallbackReason;
  const details = denialDetails(decision.detail, level);
  return new HttpError(403, "forbidden", reason, {
    hint: denialHint(decision.detail, level),
    ...(details ? { details } : {}),
  });
}

export function requirePermission(
  permission: string,
  resourceFrom?: ResourceFromFn,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await ensurePermission(c, permission, resourceFrom ? resourceFrom(c) : undefined);
    await next();
  };
}

export async function ensurePermission(
  c: Context<AppEnv>,
  permission: string,
  resource: { type: string; id: string } | undefined,
): Promise<void> {
  const principal = c.get("principal");
  if (!principal) {
    throw new UnauthorizedError();
  }
  const db = c.get("db");
  const resourceArg = resource?.id ? resource : undefined;
  const check = resourceArg
    ? {
        tenant_id: principal.tenant_id,
        principal,
        permission,
        resource: resourceArg,
      }
    : {
        tenant_id: principal.tenant_id,
        principal,
        permission,
      };
  const decision = await can(db, check);
  if (decision.allow && permission === "workflow:run" && resourceArg?.type === "workflow") {
    c.set(
      "workflow_permission",
      await captureWorkflowPermission(db, principal, resourceArg.id, decision),
    );
  }
  if (!decision.allow) {
    try {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.POLICY_DENIED,
          resource_type: resourceArg?.type ?? "policy",
          resource_id: resourceArg?.id ?? null,
          result: "denied",
          reason: decision.reason ?? `permission_denied:${permission}`,
          metadata: {
            permission,
            resource_type: resourceArg?.type ?? null,
            resource_id: resourceArg?.id ?? null,
          },
        },
        db,
      );
    } catch {}
    throw await forbiddenFor(
      db,
      principal,
      decision,
      resourceArg,
      `permission_denied:${permission}`,
    );
  }
}

export function requireAnyPermission(
  permissions: readonly string[],
  resourceFrom?: ResourceFromFn,
): MiddlewareHandler<AppEnv> {
  if (permissions.length === 0) {
    throw new Error("requireAnyPermission: at least one permission required");
  }
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      throw new UnauthorizedError();
    }
    const db = c.get("db");
    const resource = resourceFrom ? resourceFrom(c) : undefined;
    const resourceArg = resource?.id ? resource : undefined;
    let lastDecision: Decision | undefined;
    let lastReason: string | undefined;
    for (const permission of permissions) {
      const check = resourceArg
        ? {
            tenant_id: principal.tenant_id,
            principal,
            permission,
            resource: resourceArg,
          }
        : {
            tenant_id: principal.tenant_id,
            principal,
            permission,
          };
      const decision = await can(db, check);
      if (decision.allow && permission === "workflow:run" && resourceArg?.type === "workflow") {
        c.set(
          "workflow_permission",
          await captureWorkflowPermission(db, principal, resourceArg.id, decision),
        );
      }
      if (decision.allow) {
        await next();
        return;
      }
      lastDecision = decision;
      lastReason = decision.reason ?? `permission_denied:${permission}`;
    }
    const primary = permissions[0] ?? "unknown";
    try {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.POLICY_DENIED,
          resource_type: resourceArg?.type ?? "policy",
          resource_id: resourceArg?.id ?? null,
          result: "denied",
          reason: lastReason ?? `permission_denied:${primary}`,
          metadata: {
            permission: primary,
            permission_alternates: permissions.slice(1),
            resource_type: resourceArg?.type ?? null,
            resource_id: resourceArg?.id ?? null,
          },
        },
        db,
      );
    } catch {}
    throw await forbiddenFor(
      db,
      principal,
      lastDecision ?? { allow: false },
      resourceArg,
      `permission_denied:${primary}`,
    );
  };
}

export function gateOtherMethods(
  methods: readonly string[],
  gate: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  return (c, next) => (methods.includes(c.req.method) ? next() : gate(c, next));
}
