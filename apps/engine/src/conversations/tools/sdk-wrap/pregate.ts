import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../../db/client.ts";
import {
  apiKeys,
  connectors,
  knowledgeSources,
  portalTokens,
  skills,
  subscriptions,
  workflows,
} from "../../../db/schema/index.ts";
import type {
  ConversationTool,
  ToolContext,
  ToolEffect,
  ToolPrecheck,
  ToolResult,
} from "../index.ts";
import { checkToolPermission, type ToolPermissionResult } from "../permission-gate.ts";

export function permissionRefusal(
  inner: ConversationTool,
  denied: Extract<ToolPermissionResult, { allow: false }>,
): ToolResult {
  return (
    inner.permission?.denyResult?.(denied.permission, denied.reason) ?? {
      ok: false,
      data: {
        error: "permission_denied",
        permission: denied.permission,
        reason: denied.reason,
      },
    }
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResourceLookup = (db: Executor, tenant_id: string, id: string) => Promise<boolean>;

const RESOURCE_LOOKUPS: Readonly<Record<string, ResourceLookup>> = {
  workflow: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, tenant_id),
            eq(workflows.id, id),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1)
    ).length > 0,
  connector: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          and(
            eq(connectors.tenant_id, tenant_id),
            eq(connectors.id, id),
            isNull(connectors.deleted_at),
          ),
        )
        .limit(1)
    ).length > 0,
  knowledge: async (db, tenant_id, id) => knowledgeSourceExists(db, tenant_id, id),
  knowledge_source: async (db, tenant_id, id) => knowledgeSourceExists(db, tenant_id, id),
  skill: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
        .limit(1)
    ).length > 0,
  subscription: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.tenant_id, tenant_id), eq(subscriptions.id, id)))
        .limit(1)
    ).length > 0,
  api_key: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.tenant_id, tenant_id), eq(apiKeys.id, id)))
        .limit(1)
    ).length > 0,
  portal_token: async (db, tenant_id, id) =>
    (
      await db
        .select({ id: portalTokens.id })
        .from(portalTokens)
        .where(and(eq(portalTokens.tenant_id, tenant_id), eq(portalTokens.id, id)))
        .limit(1)
    ).length > 0,
};

async function knowledgeSourceExists(
  db: Executor,
  tenant_id: string,
  id: string,
): Promise<boolean> {
  return (
    (
      await db
        .select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, tenant_id),
            eq(knowledgeSources.id, id),
            isNull(knowledgeSources.deleted_at),
          ),
        )
        .limit(1)
    ).length > 0
  );
}

const LOOKUP_TOOLS: Readonly<Record<string, readonly string[]>> = {
  workflow: ["find_workflow", "list_workflows"],
  connector: ["find_connector", "list_connectors"],
};

function resourceMissing(inner: ConversationTool, resourceType: string): ToolResult {
  const error_code = `${resourceType}_not_found`;
  const message = `${inner.name} names a ${resourceType.replace(/_/g, " ")} that does not exist in this tenant. Nothing ran and nobody was asked to approve it. Look the ${resourceType.replace(/_/g, " ")} up first; do not retry this reference.`;
  const next = LOOKUP_TOOLS[resourceType];
  return {
    ok: false,
    error_code,
    message,
    data: { error: { code: error_code, message } },
    ...(next ? { next_best_actions: [...next] } : {}),
  };
}

async function namedResourceMissing(
  inner: ConversationTool,
  ctx: ToolContext,
  rawArgs: Record<string, unknown>,
): Promise<ToolResult | null> {
  const permission = inner.permission;
  if (!permission) return null;
  if (permission.resolveResourceId) {
    const resolved = await permission.resolveResourceId(ctx, rawArgs);
    if (resolved === null) return resourceMissing(inner, permission.resourceType);
    const lookup = RESOURCE_LOOKUPS[permission.resourceType];
    if (!lookup) return null;
    if (!UUID_RE.test(resolved) || !(await lookup(ctx.db, ctx.tenant_id, resolved)))
      return resourceMissing(inner, permission.resourceType);
    return null;
  }
  if (!permission.resourceIdArg) return null;
  const named = rawArgs[permission.resourceIdArg];
  if (named === undefined || named === null) return null;
  const lookup = RESOURCE_LOOKUPS[permission.resourceType];
  if (!lookup) return null;
  const id = String(named);
  if (!UUID_RE.test(id) || !(await lookup(ctx.db, ctx.tenant_id, id)))
    return resourceMissing(inner, permission.resourceType);
  return null;
}

export async function checkBeforeGate(
  inner: ConversationTool,
  ctx: ToolContext,
  rawArgs: Record<string, unknown>,
): Promise<ToolPrecheck> {
  if (inner.permission) {
    const permitted = await checkToolPermission(ctx, inner.permission, rawArgs);
    if (!permitted.allow) return { ok: false, result: permissionRefusal(inner, permitted) };
  }
  const missing = await namedResourceMissing(inner, ctx, rawArgs);
  if (missing) return { ok: false, result: missing };
  return inner.precheck ? inner.precheck(ctx, rawArgs) : { ok: true };
}

export function describeToolEffect(effect: ToolEffect): string {
  return `${effect.connector}: ${effect.method}${effect.target ? ` ${effect.target}` : ""}`;
}
