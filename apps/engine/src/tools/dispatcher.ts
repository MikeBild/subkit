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

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { PermissionMode } from "../conversations/tool-policies.ts";
import type { ToolContext, ToolResult } from "../conversations/tools/index.ts";
import type { Db } from "../db/client.ts";
import { auditLog } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { denialDetails, denialHint } from "../rbac/denial.ts";
import { type ConnectorAccessLevel, can, connectorAccessLevel } from "../rbac/evaluator.ts";
import {
  ARGS_CONFIRM_ID_KEY,
  ARGS_CONFIRM_KEY,
  DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON,
  isConfirmedRequest,
  policyDecide,
  SK_CONFIRM_ID_META_KEY,
} from "./policy.ts";
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

// Deterministic JSON: object keys sorted recursively so an arg fingerprint
// is stable across key ordering and whitespace. Arrays keep their order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// Fingerprint of a tool call's args, invariant to the confirm control markers
// the model adds on the re-issue. Computed identically at request time (the
// original call) and verify time (the confirmed re-issue), so a model that
// gets approval for {id:A} and re-issues {id:B} produces a different hash and
// is rejected. Marker stripping MUST cover every field the re-issue injects
// (see policy.ts) or a legitimate re-issue false-trips.
export function hashToolArgs(args: Record<string, unknown>): string {
  const stripped: Record<string, unknown> = { ...args };
  delete stripped[ARGS_CONFIRM_KEY];
  delete stripped[ARGS_CONFIRM_ID_KEY];
  return createHash("sha256").update(stableStringify(stripped)).digest("hex");
}

async function emitApprovalRequested(
  deps: DispatchDeps,
  toolName: string,
  surface: ToolSurface,
  tool_call_id: string,
  argsHash: string,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: deps.principal.tenant_id,
      // Branch on principal.kind so a user-triggered confirm produces
      // actor_type="user" — matches APPROVAL_APPROVED + POLICY_DENIED
      // below and lets compliance joins on actor_type stay consistent
      // across the full APPROVAL_REQUESTED → APPROVAL_APPROVED lifecycle.
      actor_type: deps.principal.kind === "user" ? "user" : "system_account",
      actor_id: deps.principal.id,
      action: AuditAction.APPROVAL_REQUESTED,
      resource_type: surface === "mcp" ? "mcp_tool_call" : "conversation_tool_call",
      resource_id: tool_call_id,
      result: "success",
      metadata: {
        tool: toolName,
        request_source: surface,
        policy_mode: "confirm_before_execution",
        // Binds the approval to the exact args it was granted for. Verified
        // on the MCP re-issue (verifyMcpConfirmation) to close the
        // approve-{id:A}-then-execute-{id:B} arg-tamper gap.
        args_hash: argsHash,
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
      actor_type: deps.principal.kind === "user" ? "user" : "system_account",
      actor_id: deps.principal.id,
      action: AuditAction.APPROVAL_APPROVED,
      resource_type: surface === "mcp" ? "mcp_tool_call" : "conversation_tool_call",
      // Same resource_id as the APPROVAL_REQUESTED row — lets compliance
      // tooling join the two rows into a single approval lifecycle.
      // Callers pass the original tool_call_id back via `_meta.sk_confirm_id`
      // (MCP) or `__policy_confirm_id` (chat args). The dispatcher
      // SKIPS this emit when neither marker is present (see
      // confirmIdFromInvocation), so a missing id never produces an
      // orphan join row.
      resource_id: tool_call_id,
      result: "success",
      metadata: { tool: toolName, request_source: surface },
    },
    deps.db,
  );
}

/** Pull the original APPROVAL_REQUESTED tool_call_id out of the
 *  confirmed re-issue. Two conventions for symmetry with sdk-wrap /
 *  policy-gate: `_meta.sk_confirm_id` on MCP, `__policy_confirm_id`
 *  inside args on chat. Returns `null` when neither is present —
 *  the dispatcher then SKIPS writing APPROVAL_APPROVED rather than
 *  producing an orphan row that can't join APPROVAL_REQUESTED. */
function confirmIdFromInvocation(invocation: ToolInvocation): string | null {
  const fromMeta = invocation.meta?.[SK_CONFIRM_ID_META_KEY];
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  const fromArgs = (invocation.args as Record<string, unknown>)[ARGS_CONFIRM_ID_KEY];
  if (typeof fromArgs === "string" && fromArgs.length > 0) return fromArgs;
  return null;
}

/** Validate a model-suppliable MCP confirmation against the audit trail.
 *  On MCP a confirmation is forgeable — `confirm_tool_call` (or any client
 *  that can set `_meta.sk_confirm`) passes the tool, args, and confirm_id
 *  itself. Without this check it could approve an arbitrary or recycled id
 *  and bypass the gate, writing an APPROVAL_APPROVED that joins no request.
 *  A confirmation is valid only when a matching APPROVAL_REQUESTED exists
 *  for this tenant + tool and has NOT already been approved (single-use).
 *  Chat confirmations are UI-driven and keep the legacy id-optional path. */
async function verifyMcpConfirmation(
  deps: DispatchDeps,
  toolName: string,
  approvalId: string | null,
  currentArgsHash: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (approvalId === null) {
    return {
      ok: false,
      code: "confirmation_missing_id",
      message:
        "Confirmed call carried no confirm_id. Re-issue the original call, then approve the returned tool_call_id.",
    };
  }
  const rows = await deps.db
    .select({ action: auditLog.action, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, deps.principal.tenant_id), eq(auditLog.resource_id, approvalId)),
    );
  const requested = rows.find((r) => r.action === AuditAction.APPROVAL_REQUESTED);
  if (!requested) {
    return {
      ok: false,
      code: "unknown_confirmation",
      message: `No pending confirmation matches confirm_id ${approvalId} for this tenant. Re-issue the original call to obtain one.`,
    };
  }
  const requestedTool = (requested.metadata as { tool?: unknown } | null)?.tool;
  if (typeof requestedTool === "string" && requestedTool !== toolName) {
    return {
      ok: false,
      code: "confirmation_tool_mismatch",
      message: `Confirmation ${approvalId} was issued for ${requestedTool}, not ${toolName}.`,
    };
  }
  // Args fingerprint: reject a confirmed re-issue whose args differ from the
  // ones the approval was granted for. `args_hash` is absent on pre-upgrade
  // approval rows — tolerate that (don't reject) so in-flight confirmations
  // minted before this shipped still work; new approvals always carry it.
  const requestedArgsHash = (requested.metadata as { args_hash?: unknown } | null)?.args_hash;
  if (typeof requestedArgsHash === "string" && requestedArgsHash !== currentArgsHash) {
    return {
      ok: false,
      code: "confirmation_args_mismatch",
      message: `Confirmation ${approvalId} was granted for different arguments. Re-issue the call with the arguments you want to confirm, then approve the returned tool_call_id.`,
    };
  }
  if (rows.some((r) => r.action === AuditAction.APPROVAL_APPROVED)) {
    return {
      ok: false,
      code: "confirmation_already_used",
      message: `Confirmation ${approvalId} was already used. Re-issue the call to obtain a fresh confirmation.`,
    };
  }
  return { ok: true };
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
      actor_type: deps.principal.kind === "user" ? "user" : "system_account",
      actor_id: deps.principal.id,
      action: AuditAction.POLICY_DENIED,
      resource_type: resource?.type ?? "tool",
      resource_id: resource?.id ?? toolName,
      result: "denied",
      reason,
      metadata: {
        tool: toolName,
        request_source: surface,
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
        // The LLM/operator reads `message` — surface the actionable hint,
        // not the bare `permission_denied:…` code. The machine reason is
        // recoverable from `details.cause`.
        envelope = {
          status: "error",
          error_code: "policy_denied",
          message: denialHint(decision.detail, level),
          ...(details ? { details } : {}),
        };
        decisionLabel = "policy_denied";
        rbacDenied = true;
      }
    }

    if (rbacDenied) {
      // Skip remainder of the pipeline; the final log emit below still
      // fires so observability sees the denial.
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
          hashToolArgs(invocation.args),
        );
        envelope = { status: "needs_confirm", confirm: policy.envelope };
        decisionLabel = "needs_confirm";
      } else {
        // 5. Emit APPROVAL_APPROVED when the caller re-issued a previously
        //    paused call. Use the original tool_call_id so the audit
        //    row joins APPROVAL_REQUESTED for the same lifecycle.
        //    If the caller forgot to carry the id back (legacy client),
        //    SKIP the row and log a warning — better an audit gap that
        //    the operator can spot than an orphan row that compliance
        //    queries silently include in lifecycle joins.
        let confirmRejected = false;
        if (isConfirmedRequest(invocation.args, invocation.meta)) {
          const approvalId = confirmIdFromInvocation(invocation);
          // On MCP a confirmation is model-suppliable — validate it against a
          // real, un-consumed APPROVAL_REQUESTED so it can't approve an
          // arbitrary or recycled id and bypass the gate. The elicitation
          // re-dispatch passes (the engine just issued the request this turn)
          // and chat stays on the UI-driven legacy path below.
          if (invocation.surface === "mcp") {
            const check = await verifyMcpConfirmation(
              deps,
              entry.descriptor.name,
              approvalId,
              hashToolArgs(invocation.args),
            );
            if (!check.ok) {
              envelope = { status: "error", error_code: check.code, message: check.message };
              decisionLabel = check.code;
              confirmRejected = true;
            }
          }
          if (!confirmRejected) {
            if (approvalId !== null) {
              await emitApprovalApproved(
                deps,
                entry.descriptor.name,
                invocation.surface,
                approvalId,
              );
            } else {
              logger.warn({
                module: "tools",
                action: "tool.dispatch.confirm_id_missing",
                msg: "sk_confirm without sk_confirm_id — APPROVAL_APPROVED skipped to avoid orphan row",
                tool: invocation.name,
                surface: invocation.surface,
                principal_id: deps.principal.id,
                tenant_id: deps.principal.tenant_id,
              });
            }
          }
        }

        // 6. Execute — unless the confirmation was rejected above.
        if (!confirmRejected) {
          try {
            const executor = entry.executor;
            if (isConversationExecutor(executor)) {
              // Draft-dependency guard. Off the chat surface the dispatcher
              // runs conversation tools against the MCP stub context, whose
              // `getDraft()` returns an EMPTY draft and whose `setDraft()` is
              // a no-op (see mcp/adapter.ts#buildMcpStubCtx). A tool that
              // needs the live conversation draft (`requires_draft`) would
              // therefore operate on nothing and hand back a misleading
              // success. Reject it with a terminal not_available_on_surface —
              // pointing the caller at conversation_start — instead of the
              // silent empty-draft no-op. Chat keeps the real conversationCtx,
              // so this never fires there.
              const usingStubCtx =
                invocation.surface !== "chat" && deps.buildMcpStubCtx !== undefined;
              if (usingStubCtx && entry.descriptor.requires_draft) {
                envelope = {
                  status: "not_available_on_surface",
                  reason: DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON,
                };
              } else {
                const ctx =
                  invocation.surface === "chat"
                    ? deps.conversationCtx
                    : (deps.buildMcpStubCtx?.(entry.descriptor.name) ?? deps.conversationCtx);
                if (!ctx) {
                  throw new Error("dispatcher missing conversation ctx for tool execution");
                }
                const result = await executor.execute(ctx, invocation.args);
                envelope = normalizeConversationResult(result);
              }
            } else if (isStaticExecutor(executor)) {
              envelope = await executor.invoke(
                { db: deps.db, principal: deps.principal },
                invocation.args,
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
  }

  // 8. Log one envelope per dispatch. Include `reason` when the
  //    envelope carries it (error_code, disabled reason,
  //    not_available_on_surface reason) so operators reading
  //    `sk logs` don't need to cross-reference the audit table to
  //    learn WHY a dispatch failed or short-circuited.
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
