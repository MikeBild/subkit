import type { z } from "@hono/zod-openapi";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { PermissionMode } from "../conversations/tool-policies.ts";
import type { ToolContext, ToolResult } from "../conversations/tools/index.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import { denialDetails, denialHint } from "../rbac/denial.ts";
import { type ConnectorAccessLevel, can, connectorAccessLevel } from "../rbac/evaluator.ts";
import {
  type ApprovalAuditResource,
  approvalAuditResource,
  type ClaimedApproval,
  consumeApproval,
  hashToolArgs,
  recordApprovalApproved,
  recordApprovalUnfulfilled,
  requestApproval,
} from "./approval.ts";
import { isDirectConnectorTool } from "./direct-connector-binding.ts";
import {
  confirmIdFromArgs,
  DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON,
  isConfirmedRequest,
  policyDecide,
  SK_CONFIRM_ID_META_KEY,
  SK_CONFIRM_META_KEY,
} from "./policy.ts";
import type { ConversationProviderEntry } from "./providers/conversation.ts";
import type { StaticProviderEntry } from "./providers/static.ts";
import type { ToolRegistry } from "./registry.ts";
import type { ConfirmEnvelope, ToolEnvelope, ToolInvocation, ToolSurface } from "./types.ts";

export interface DispatchDeps {
  readonly registry: ToolRegistry;
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly conversationCtx?: ToolContext;
  readonly buildMcpStubCtx?: (toolName: string) => ToolContext;
  readonly permissionMode?: PermissionMode | null;
  readonly loadedSkills?: ReadonlySet<string>;
  readonly mcpMode?: "product" | "authoring" | "admin";
  readonly readOnly?: boolean;
}

function normalizeConversationResult(r: ToolResult): ToolEnvelope {
  if (r.ok) {
    return {
      status: "ok",
      data: r.data,
      ...(r.pause ? { pause: r.pause } : {}),
      ...(r.committed_workflow_id ? { committed_workflow_id: r.committed_workflow_id } : {}),
    };
  }
  const details = r.details !== undefined ? r.details : r.data;
  const own = (field: "error_code" | "message"): string | undefined => {
    const value = (details as Record<string, unknown> | null | undefined)?.[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  return {
    status: "error",
    error_code: r.error_code ?? own("error_code") ?? "tool_failed",
    message: r.message ?? own("message") ?? "tool returned ok=false",
    ...(details !== undefined ? { details } : {}),
    ...(r.next_best_actions ? { next_best_actions: r.next_best_actions } : {}),
  };
}

function confirmIdFromInvocation(invocation: ToolInvocation): string | null {
  const fromMeta = invocation.meta?.[SK_CONFIRM_ID_META_KEY];
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  return confirmIdFromArgs(invocation.args as Record<string, unknown>);
}

function usesStubDraftContext(deps: DispatchDeps, invocation: ToolInvocation): boolean {
  return invocation.surface !== "chat" && deps.buildMcpStubCtx !== undefined;
}

function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return typeof (schema as { safeParse?: unknown } | null)?.safeParse === "function";
}

type CanonicalArgs =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly message: string; readonly details: unknown };

function canonicalizeArgs(schema: unknown, raw: Record<string, unknown>): CanonicalArgs {
  if (!isZodSchema(schema)) return { ok: true, args: raw };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    }));
    const first = issues[0];
    return {
      ok: false,
      message: first
        ? `invalid arguments${first.path ? ` at \`${first.path}\`` : ""}: ${first.message}`
        : "invalid arguments",
      details: { issues },
    };
  }
  const data: unknown = parsed.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: true, args: raw };
  }
  return { ok: true, args: data as Record<string, unknown> };
}

async function emitPolicyDenied(
  deps: DispatchDeps,
  toolName: string,
  surface: ToolSurface,
  permission: string,
  reason: string,
  resource: { type: string; id: string } | null,
  approval: ApprovalAuditResource | null,
  args: Record<string, unknown>,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: deps.principal.tenant_id,
      actor_type: deps.principal.kind === "user" ? "user" : "system_account",
      actor_id: deps.principal.id,
      action: AuditAction.POLICY_DENIED,
      resource_type: approval?.resource_type ?? resource?.type ?? "tool",
      resource_id: approval?.approval_id ?? resource?.id ?? toolName,
      result: "denied",
      reason,
      metadata: {
        tool: toolName,
        canonical_tool: toolName,
        via: surface,
        request_source: surface,
        permission,
        args_hash: hashToolArgs(args),
        ...(approval ? { approval_id: approval.approval_id } : {}),
        ...(approval && resource
          ? { rbac_resource_type: resource.type, rbac_resource_id: resource.id }
          : {}),
      },
    },
    deps.db,
  );
}

async function gateConfirm(
  deps: DispatchDeps,
  toolName: string,
  invocation: ToolInvocation,
  confirm: ConfirmEnvelope,
  args: { execArgs: Record<string, unknown> },
): Promise<ToolEnvelope> {
  const { approval_url } = await requestApproval({
    db: deps.db,
    principal: deps.principal,
    approval_id: confirm.tool_call_id,
    tool: toolName,
    surface: invocation.surface,
    via: invocation.surface,
    reason: confirm.reason,
    execution_mode: null,
    args: args.execArgs,
  });
  return { status: "needs_confirm", confirm: { ...confirm, approval_url } };
}

export async function dispatchTool(
  deps: DispatchDeps,
  invocation: ToolInvocation,
): Promise<ToolEnvelope> {
  const t0 = Date.now();

  const entry = deps.registry.get(invocation.name, {
    surface: invocation.surface,
    ...(deps.mcpMode !== undefined ? { mcpMode: deps.mcpMode } : {}),
    ...(deps.loadedSkills !== undefined ? { loadedSkills: deps.loadedSkills } : {}),
    ...(deps.readOnly !== undefined ? { readOnly: deps.readOnly } : {}),
  });

  let envelope: ToolEnvelope = {
    status: "error",
    error_code: "dispatcher_unreachable",
    message: "dispatcher reached end without setting envelope",
  };
  let decisionLabel = "unreachable";

  if (!entry) {
    envelope = {
      status: "error",
      error_code: "tool_not_found",
      message: `unknown tool: ${invocation.name}`,
    };
    decisionLabel = "tool_not_found";
  } else if (entry.descriptor.disabled) {
    envelope = {
      status: "not_available_on_surface",
      reason: entry.descriptor.disabled.reason,
    };
    decisionLabel = "not_available_on_surface";
  } else if (usesStubDraftContext(deps, invocation) && entry.descriptor.requires_draft) {
    envelope = {
      status: "not_available_on_surface",
      reason: DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON,
    };
    decisionLabel = "not_available_on_surface";
  } else {
    const confirmed = isConfirmedRequest(invocation.args, invocation.meta);
    let halted = false;
    let execArgs: Record<string, unknown> = invocation.args;
    let canonicalizedForResource = false;
    let claimed: ClaimedApproval | null = null;

    if (confirmed) {
      const claim = await consumeApproval({
        db: deps.db,
        principal: deps.principal,
        approval_id: confirmIdFromInvocation(invocation),
        tool: entry.descriptor.name,
        surface: invocation.surface,
        via: invocation.surface,
      });
      if (!claim.ok) {
        envelope = { status: "error", error_code: claim.code, message: claim.message };
        decisionLabel = claim.code;
        halted = true;
      } else {
        claimed = claim;
        execArgs = claim.args;
      }
    }

    if (!halted && entry.descriptor.rbac) {
      let resource = entry.descriptor.rbac.resource
        ? entry.descriptor.rbac.resource(execArgs)
        : undefined;
      const executor = entry.executor;
      if (isConversationExecutor(executor) && executor.tool?.permission?.resolveResourceId) {
        const canonical = claimed
          ? { ok: true as const, args: execArgs as Record<string, unknown> }
          : canonicalizeArgs(entry.descriptor.inputSchema, execArgs);
        if (canonical.ok) {
          execArgs = canonical.args;
          canonicalizedForResource = true;
          const ctx =
            invocation.surface === "chat"
              ? deps.conversationCtx
              : (deps.buildMcpStubCtx?.(entry.descriptor.name) ?? deps.conversationCtx);
          if (!ctx)
            throw new Error("dispatcher missing conversation ctx for resource authorization");
          const permission = executor.tool.permission;
          const id = await permission.resolveResourceId?.(
            { ...ctx, principal: deps.principal },
            canonical.args,
          );
          resource = id ? { type: permission.resourceType, id } : undefined;
        }
      }
      const decision = await can(deps.db, {
        tenant_id: deps.principal.tenant_id,
        principal: deps.principal,
        permission: entry.descriptor.rbac.permission,
        ...(resource ? { resource } : {}),
      });
      if (!decision.allow) {
        const reason = decision.reason ?? "permission_denied";
        await emitPolicyDenied(
          deps,
          entry.descriptor.name,
          invocation.surface,
          entry.descriptor.rbac.permission,
          reason,
          resource ?? null,
          claimed ? approvalAuditResource(claimed) : null,
          execArgs,
        );
        let level: ConnectorAccessLevel | undefined;
        if (resource?.type === "connector") {
          level = await connectorAccessLevel(
            deps.db,
            deps.principal,
            resource.id,
            deps.principal.tenant_id,
          );
        }
        const details = denialDetails(decision.detail, level);
        envelope = {
          status: "error",
          error_code: "policy_denied",
          message: denialHint(decision.detail, level),
          ...(details ? { details } : {}),
        };
        decisionLabel = "policy_denied";
        halted = true;
      }
    }

    if (!halted && claimed === null && !canonicalizedForResource) {
      const canonical = canonicalizeArgs(entry.descriptor.inputSchema, execArgs);
      if (!canonical.ok) {
        envelope = {
          status: "error",
          error_code: "invalid_args",
          message: `${invocation.name}: ${canonical.message}`,
          details: canonical.details,
        };
        decisionLabel = "invalid_args";
        halted = true;
      } else {
        execArgs = canonical.args;
      }
    }

    if (halted) {
    } else {
      const policyMeta = confirmed
        ? { ...(invocation.meta ?? {}), [SK_CONFIRM_META_KEY]: true }
        : invocation.meta;
      const policy = policyDecide({
        tool: entry.descriptor.name,
        category: entry.descriptor.category,
        surface: invocation.surface,
        args: execArgs,
        ...(policyMeta !== undefined ? { meta: policyMeta } : {}),
        ...(deps.permissionMode !== undefined && deps.permissionMode !== null
          ? { permission_mode: deps.permissionMode }
          : {}),
      });

      if (policy.kind === "not_available_on_surface") {
        if (claimed !== null) {
          await recordApprovalUnfulfilled({
            db: deps.db,
            principal: deps.principal,
            claim: claimed,
            tool: entry.descriptor.name,
            via: invocation.surface,
            reason: policy.reason,
          });
        }
        envelope = { status: "not_available_on_surface", reason: policy.reason };
        decisionLabel = "not_available_on_surface";
        halted = true;
      } else if (policy.kind === "needs_confirm") {
        envelope = await gateConfirm(deps, entry.descriptor.name, invocation, policy.envelope, {
          execArgs,
        });
        decisionLabel = "needs_confirm";
        halted = true;
      }

      if (halted) {
      } else if (
        claimed !== null &&
        !(await recordApprovalApproved({
          db: deps.db,
          principal: deps.principal,
          claim: claimed,
          tool: entry.descriptor.name,
          via: invocation.surface,
        }))
      ) {
        envelope = {
          status: "error",
          error_code: "approval_audit_failed",
          message: `Confirmation ${claimed.approval_id} could not be recorded in the audit log; nothing was executed. Re-issue the original call to obtain a fresh confirmation.`,
        };
        decisionLabel = "approval_audit_failed";
      } else {
        try {
          const executor = entry.executor;
          if (isConversationExecutor(executor)) {
            const ctx =
              invocation.surface === "chat"
                ? deps.conversationCtx
                : (deps.buildMcpStubCtx?.(entry.descriptor.name) ?? deps.conversationCtx);
            if (!ctx) {
              throw new Error("dispatcher missing conversation ctx for tool execution");
            }
            const result = await executor.execute(
              {
                ...ctx,
                principal: deps.principal,
                ...(claimed && isDirectConnectorTool(claimed.tool)
                  ? {
                      direct_connector_approval: {
                        approval_id: claimed.approval_id,
                        surface: claimed.surface,
                        tool: claimed.tool,
                        binding: claimed.direct_connector ?? null,
                      },
                    }
                  : {}),
              },
              execArgs,
            );
            envelope = normalizeConversationResult(result);
          } else if (isStaticExecutor(executor)) {
            envelope = await executor.invoke(
              {
                db: deps.db,
                principal: deps.principal,
                registry: deps.registry,
                resumeApproval: (tool, approvalId) =>
                  dispatchTool(deps, {
                    surface: invocation.surface,
                    name: tool,
                    args: {},
                    meta: { [SK_CONFIRM_META_KEY]: true, [SK_CONFIRM_ID_META_KEY]: approvalId },
                  }),
                ...(deps.mcpMode !== undefined ? { mcpMode: deps.mcpMode } : {}),
                ...(deps.readOnly !== undefined ? { readOnly: deps.readOnly } : {}),
              },
              execArgs,
            );
          } else {
            throw new Error("unknown executor kind in registry entry");
          }
          decisionLabel =
            envelope.status === "ok"
              ? "ok"
              : envelope.status === "not_available_on_surface"
                ? "not_available_on_surface"
                : "error";
        } catch (err) {
          envelope = {
            status: "error",
            error_code: "tool_execute_failed",
            message: err instanceof Error ? err.message : String(err),
          };
          decisionLabel = "execute_failed";
        }
      }
    }
  }

  const logReason =
    envelope.status === "error"
      ? envelope.error_code
      : envelope.status === "not_available_on_surface"
        ? envelope.reason
        : undefined;
  logger.info({
    module: "tools",
    action: "tool.dispatch.invoke",
    msg: "tool dispatched",
    tool: invocation.name,
    surface: invocation.surface,
    principal_id: deps.principal.id,
    tenant_id: deps.principal.tenant_id,
    decision: decisionLabel,
    duration_ms: Date.now() - t0,
    ...(logReason !== undefined ? { reason: logReason } : {}),
  });

  return envelope;
}

function isConversationExecutor(e: unknown): e is ConversationProviderEntry {
  return typeof e === "object" && e !== null && (e as { kind?: string }).kind === "conversation";
}

function isStaticExecutor(e: unknown): e is StaticProviderEntry {
  return typeof e === "object" && e !== null && (e as { kind?: string }).kind === "static";
}
