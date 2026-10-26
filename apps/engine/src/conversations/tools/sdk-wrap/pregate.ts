import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
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
import { can } from "../../../rbac/evaluator.ts";
import type {
  ConversationTool,
  ToolContext,
  ToolEffect,
  ToolPrecheck,
  ToolResult,
} from "../index.ts";
import {
  checkToolPermission,
  resolveConversationPrincipal,
  type ToolPermissionResult,
} from "../permission-gate.ts";
import {
  INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE,
  INTAKE_REVIEW_REMOVED_TOOLS,
  intakeReviewInProgress,
} from "./intake-review-guard.ts";

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

const RESOURCE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  workflow: ["update_workflow", "get_workflow"],
  connector: ["update_connector", "get_connector"],
  knowledge_source: ["update_knowledge_source", "get_knowledge_source"],
  skill: ["update_skill", "get_skill"],
  subscription: ["update_subscription", "get_subscription"],
  api_key: ["get_api_key"],
  portal_token: [],
};

function canonicalResourceType(resourceType: string): string {
  return resourceType === "knowledge" ? "knowledge_source" : resourceType;
}

function resourceLabel(resourceType: string): string {
  return canonicalResourceType(resourceType).replace(/_/g, " ");
}

const RESOURCE_READ_PERMISSIONS: Readonly<Record<string, { action: string; type: string }>> = {
  workflow: { action: "workflow:read", type: "workflow" },
  connector: { action: "connector:read", type: "connector" },
  knowledge_source: { action: "knowledge:read", type: "knowledge" },
  skill: { action: "skill:read", type: "skill" },
  subscription: { action: "subscription:read", type: "subscription" },
  api_key: { action: "api_key:read", type: "api_key" },
  portal_token: { action: "portal_token:read", type: "portal_token" },
};

async function mayReadResource(
  ctx: ToolContext,
  principal: ResolvedPrincipal | null,
  type: string,
  id: string,
): Promise<boolean> {
  if (!principal) return true;
  const read = RESOURCE_READ_PERMISSIONS[type];
  if (!read) return false;
  const decision = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal,
    permission: read.action,
    resource: { type: read.type, id },
    quiet: true,
  });
  return decision.allow;
}

async function actualResourceType(
  ctx: ToolContext,
  resourceType: string,
  id: string,
): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;
  const own = canonicalResourceType(resourceType);
  const principal = ctx.principal ?? (await resolveConversationPrincipal(ctx));
  for (const type of Object.keys(RESOURCE_TOOLS)) {
    if (type === own) continue;
    const lookup = RESOURCE_LOOKUPS[type];
    if (!lookup || !(await lookup(ctx.db, ctx.tenant_id, id))) continue;
    return (await mayReadResource(ctx, principal, type, id)) ? type : null;
  }
  return null;
}

function inIntakeReview(ctx: ToolContext): boolean {
  try {
    return intakeReviewInProgress(ctx.getDraft());
  } catch {
    return false;
  }
}

function resourceMissing(
  inner: ConversationTool,
  ctx: ToolContext,
  resourceType: string,
  actualType: string | null = null,
): ToolResult {
  const error_code = `${resourceType}_not_found`;
  const label = resourceLabel(resourceType);
  const intakeReview = inIntakeReview(ctx);
  if (actualType) {
    const actualLabel = resourceLabel(actualType);
    const candidates = RESOURCE_TOOLS[actualType] ?? [];
    const removedByReview = intakeReview
      ? candidates.filter((name) => INTAKE_REVIEW_REMOVED_TOOLS.includes(name))
      : [];
    const usable = candidates.filter(
      (name) =>
        name !== inner.name &&
        !removedByReview.includes(name) &&
        ctx.availableToolNames?.has(name) === true,
    );
    const guidance =
      usable.length > 0
        ? `Use ${usable.join(" or ")} for this ${actualLabel}.`
        : ctx.availableToolNames === undefined
          ? `Use a ${actualLabel} tool for this id instead.`
          : `No ${actualLabel} tool for this id is available in this conversation; tell the person instead of trying another tool.`;
    const message = [
      `${inner.name} names a ${label} that does not exist in this tenant; the id belongs to an existing ${actualLabel}. Nothing ran and nobody was asked to approve it.`,
      guidance,
      `Do not call ${inner.name} with this id.`,
      ...(removedByReview.length > 0 ? [INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE] : []),
    ].join(" ");
    return {
      ok: false,
      error_code,
      message,
      data: { error: { code: error_code, message }, actual_resource_type: actualType },
      ...(usable.length > 0 ? { next_best_actions: usable } : {}),
    };
  }
  const message = [
    `${inner.name} names a ${label} that does not exist in this tenant. Nothing ran and nobody was asked to approve it. Look the ${label} up first; do not retry this reference.`,
    ...(intakeReview ? [INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE] : []),
  ].join(" ");
  const next = LOOKUP_TOOLS[resourceType];
  return {
    ok: false,
    error_code,
    message,
    data: { error: { code: error_code, message } },
    ...(next ? { next_best_actions: [...next] } : {}),
  };
}

async function missingResource(
  inner: ConversationTool,
  ctx: ToolContext,
  resourceType: string,
  id: string,
): Promise<ToolResult | null> {
  const lookup = RESOURCE_LOOKUPS[resourceType];
  if (!lookup) return null;
  if (UUID_RE.test(id) && (await lookup(ctx.db, ctx.tenant_id, id))) return null;
  return resourceMissing(inner, ctx, resourceType, await actualResourceType(ctx, resourceType, id));
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
    if (resolved === null) return resourceMissing(inner, ctx, permission.resourceType);
    return missingResource(inner, ctx, permission.resourceType, resolved);
  }
  if (!permission.resourceIdArg) return null;
  const named = rawArgs[permission.resourceIdArg];
  if (named === undefined || named === null) return null;
  return missingResource(inner, ctx, permission.resourceType, String(named));
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
