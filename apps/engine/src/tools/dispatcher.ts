// Tool dispatcher — the single entry point that both surfaces call.
//
// Pipeline (in order):
//   1. resolve     — registry.get(name) → ToolEntry or null
//   2. visibility  — disabled descriptor → not_available_on_surface
//   3. rbac        — descriptor.rbac → can() → POLICY_DENIED on deny
//                    (runs BEFORE policy so an unauthorized caller does
//                    not pollute the audit log with APPROVAL_REQUESTED)
//   4. policy      — policyDecide() → proceed | needs_confirm | not_available
//   5. audit       — APPROVAL_REQUESTED on gate, APPROVAL_APPROVED on
//                    confirmed re-issue (correlated by tool_call_id)
//   6. execute     — call the resolved executor with the right context
//   7. normalize   — wrap the executor's output in a ToolEnvelope
//   8. log         — single tool.dispatch.invoke event per call

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { PermissionMode } from "../conversations/tool-policies.ts";
import type { ToolContext, ToolResult } from "../conversations/tools/index.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import { can } from "../rbac/evaluator.ts";
import { isConfirmedRequest, policyDecide } from "./policy.ts";
import type { ConversationProviderEntry } from "./providers/conversation.ts";
import type { StaticProviderEntry } from "./providers/static.ts";
import type { ToolRegistry } from "./registry.ts";
import type { ToolEnvelope, ToolInvocation, ToolSurface } from "./types.ts";

export interface DispatchDeps {
  readonly registry: ToolRegistry;
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  /** Real conversation context — required for chat surface; optional
   *  for MCP (where the caller may pass a stub ctx). */
  readonly conversationCtx?: ToolContext;
  /** When the dispatcher needs to build a stub conversation ctx for an
   *  MCP call (so a `tenant_read`/`tenant_write` ConversationTool can
   *  run), the adapter passes a builder. */
  readonly buildMcpStubCtx?: (toolName: string) => ToolContext;
  /** Chat-surface permission mode — threaded into policyDecide. */
  readonly permissionMode?: PermissionMode | null;
  /** Loaded skills (for visibility filter). */
  readonly loadedSkills?: ReadonlySet<string>;
  /** MCP mode (for visibility filter). */
  readonly mcpMode?: "product" | "authoring" | "admin";
  /** Read-only flag (for tenant_write hiding on MCP). */
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
  // On ok:false, preserve the legacy `data` payload as `details` when
  // the tool didn't set the structured `details` field — older tools
  // put diagnostic info there.
  const details = r.details !== undefined ? r.details : r.data;
  return {
    status: "error",
    error_code: r.error_code ?? "tool_failed",
    message: r.message ?? "tool returned ok=false",
    ...(details !== undefined ? { details } : {}),
    ...(r.next_best_actions ? { next_best_actions: r.next_best_actions } : {}),
  };
}

async function emitApprovalRequested(
  deps: DispatchDeps,
  toolName: string,
  surface: ToolSurface,
  tool_call_id: string,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: deps.principal.tenant_id,
      actor_type: "system",
      actor_id: deps.principal.id,
      action: AuditAction.APPROVAL_REQUESTED,
      resource_type: surface === "mcp" ? "mcp_tool_call" : "conversation_tool_call",
      resource_id: tool_call_id,
      result: "success",
      metadata: {
        tool: toolName,
        via: surface,
        policy_mode: "confirm_before_execution",
      },
    },
    deps.db,
  );
}

async function emitApprovalApproved(
  deps: DispatchDeps,
  toolName: string,
  surface: ToolSurface,
  tool_call_id: string,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: deps.principal.tenant_id,
      actor_type: deps.principal.kind === "user" ? "user" : "system",
      actor_id: deps.principal.id,
      action: AuditAction.APPROVAL_APPROVED,
      resource_type: surface === "mcp" ? "mcp_tool_call" : "conversation_tool_call",
      // Same resource_id as the APPROVAL_REQUESTED row — lets compliance
      // tooling join the two rows into a single approval lifecycle.
      // Callers pass the original tool_call_id back via `_meta.sk_confirm_id`
      // (MCP) or `__policy_confirm_id` (chat args). Falls back to a fresh
      // UUID if the caller didn't carry one (legacy clients).
      resource_id: tool_call_id,
      result: "success",
      metadata: { tool: toolName, via: surface },
    },
    deps.db,
  );
}

/** Pull the original APPROVAL_REQUESTED tool_call_id out of the
 *  confirmed re-issue. Two conventions for symmetry with sdk-wrap /
 *  policy-gate: `_meta.sk_confirm_id` on MCP, `__policy_confirm_id`
 *  inside args on chat. */
function confirmIdFromInvocation(invocation: ToolInvocation): string {
  const fromMeta = invocation.meta?.sk_confirm_id;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  const fromArgs = (invocation.args as { __policy_confirm_id?: unknown }).__policy_confirm_id;
  if (typeof fromArgs === "string" && fromArgs.length > 0) return fromArgs;
  return crypto.randomUUID();
}

async function emitPolicyDenied(
  deps: DispatchDeps,
  toolName: string,
  surface: ToolSurface,
  permission: string,
  reason: string,
  resource: { type: string; id: string } | null,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: deps.principal.tenant_id,
      actor_type: deps.principal.kind === "user" ? "user" : "system",
      actor_id: deps.principal.id,
      action: AuditAction.POLICY_DENIED,
      resource_type: resource?.type ?? "tool",
      resource_id: resource?.id ?? toolName,
      result: "denied",
      reason,
      metadata: {
        tool: toolName,
        via: surface,
        permission,
      },
    },
    deps.db,
  );
}

export async function dispatchTool(
  deps: DispatchDeps,
  invocation: ToolInvocation,
): Promise<ToolEnvelope> {
  const t0 = Date.now();

  // 1. Resolve.
  const entry = deps.registry.get(invocation.name, {
    surface: invocation.surface,
    ...(deps.mcpMode !== undefined ? { mcpMode: deps.mcpMode } : {}),
    ...(deps.loadedSkills !== undefined ? { loadedSkills: deps.loadedSkills } : {}),
    ...(deps.readOnly !== undefined ? { readOnly: deps.readOnly } : {}),
  });

  // Initialized with an unreachable placeholder so TS narrowing through
  // the nested rbacDenied / policy / execute branches stays happy.
  // Every branch below overwrites both before the final log emit.
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
  } else {
    // 3. RBAC — descriptor-declared permission, evaluated BEFORE the
    //    policy gate so an unauthorized caller never sees a confirm
    //    prompt and never pollutes the audit log with
    //    APPROVAL_REQUESTED. Authorization is logically prior to
    //    "should this need confirmation".
    let rbacDenied = false;
    if (entry.descriptor.rbac) {
      const resource = entry.descriptor.rbac.resource
        ? entry.descriptor.rbac.resource(invocation.args)
        : undefined;
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
        );
        envelope = {
          status: "error",
          error_code: "policy_denied",
          message: reason,
        };
        decisionLabel = "policy_denied";
        rbacDenied = true;
      }
    }

    if (rbacDenied) {
      // Skip remainder of the pipeline; the final log emit below still
      // fires so observability sees the denial.
      // biome-ignore lint/style/noUselessElse: explicit fall-through marker
    } else {
      // 4. Policy.
      const policy = policyDecide({
        tool: entry.descriptor.name,
        category: entry.descriptor.category,
        surface: invocation.surface,
        args: invocation.args,
        ...(invocation.meta !== undefined ? { meta: invocation.meta } : {}),
        ...(deps.permissionMode !== undefined && deps.permissionMode !== null
          ? { permission_mode: deps.permissionMode }
          : {}),
      });

      if (policy.kind === "not_available_on_surface") {
        envelope = { status: "not_available_on_surface", reason: policy.reason };
        decisionLabel = "not_available_on_surface";
      } else if (policy.kind === "needs_confirm") {
        await emitApprovalRequested(
          deps,
          entry.descriptor.name,
          invocation.surface,
          policy.envelope.tool_call_id,
        );
        envelope = { status: "needs_confirm", confirm: policy.envelope };
        decisionLabel = "needs_confirm";
      } else {
        // 5. Emit APPROVAL_APPROVED when the caller re-issued a previously
        //    paused call. Use the original tool_call_id so it joins
        //    APPROVAL_REQUESTED for the same lifecycle.
        if (isConfirmedRequest(invocation.args, invocation.meta)) {
          await emitApprovalApproved(
            deps,
            entry.descriptor.name,
            invocation.surface,
            confirmIdFromInvocation(invocation),
          );
        }

        // 6. Execute.
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
            const result = await executor.execute(ctx, invocation.args);
            envelope = normalizeConversationResult(result);
          } else if (isStaticExecutor(executor)) {
            envelope = await executor.invoke(
              { db: deps.db, principal: deps.principal },
              invocation.args,
            );
          } else {
            throw new Error("unknown executor kind in registry entry");
          }
          decisionLabel = envelope.status === "ok" ? "ok" : "error";
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

  // 8. Log one envelope per dispatch.
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
  });

  return envelope;
}

function isConversationExecutor(e: unknown): e is ConversationProviderEntry {
  return typeof e === "object" && e !== null && (e as { kind?: string }).kind === "conversation";
}

function isStaticExecutor(e: unknown): e is StaticProviderEntry {
  return typeof e === "object" && e !== null && (e as { kind?: string }).kind === "static";
}
