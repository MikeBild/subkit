// Tool dispatcher — the single entry point that both surfaces call.
//
// Pipeline (in order):
//   1. resolve     — registry.get(name) → ToolEntry or null
//   2. visibility  — disabled descriptor, or a draft-dependent tool off the
//                    chat surface → not_available_on_surface. Both are decided
//                    before anything can mint or burn an approval.
//   3. confirm     — a confirm marker TRIGGERS the stored approval: it claims a
//                    row a human already granted (burning the single-use handle)
//                    and REPLAYS its args; the client sends no args at all. The
//                    marker approves nothing — an ungranted row refuses the
//                    claim. And the claim is not yet an approval — see 7.
//   4. rbac        — descriptor.rbac → can() → POLICY_DENIED on deny. Runs
//                    BEFORE canonicalize and BEFORE policy: authorization is
//                    prior to input validation, so an unauthorized caller gets
//                    POLICY_DENIED (not INVALID_ARGS) whatever the arg shape,
//                    never a confirm prompt, never an APPROVAL_REQUESTED.
//                    Resource ids (connector_id, execution id, slug) are plain
//                    top-level fields, identical raw or parsed. On a replay the
//                    args are already `claim.args` (canonical).
//   5. canonicalize— parse the args that will execute through the
//                    descriptor's schema, so policy, approval, and the executor
//                    all see the same value (defaults applied). Skipped on a
//                    replay: those args were canonicalized at grant time.
//                    Executors may parse again — see canonicalizeArgs.
//   6. policy      — policyDecide() → proceed | needs_confirm | not_available
//                    On needs_confirm the approval is minted UNGRANTED and its
//                    `approval_url` handed back for a HUMAN to grant out of band.
//                    The re-issue's confirm marker (step 3) then TRIGGERS the
//                    granted row. Nothing in-band can grant it.
//   7. approve     — a claimed approval that survived rbac + policy writes
//                    APPROVAL_APPROVED, immediately before the executor runs
//   8. execute     — call the resolved executor with the right context
//   9. normalize   — wrap the executor's output in a ToolEnvelope
//  10. log         — single tool.dispatch.invoke event per call

import type { z } from "@hono/zod-openapi";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { PermissionMode } from "../conversations/tool-policies.ts";
import type { ToolContext, ToolResult } from "../conversations/tools/index.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import { denialDetails, denialHint } from "../rbac/denial.ts";
import { can, type ConnectorAccessLevel, connectorAccessLevel } from "../rbac/evaluator.ts";
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

/** Pull the original APPROVAL_REQUESTED tool_call_id out of the
 *  confirmed re-issue. Two conventions: `_meta.sk_confirm_id` on MCP,
 *  `__policy_confirm_id` inside args on chat. Reads the RAW invocation — the
 *  markers are not part of any tool's schema, and a confirmed call never
 *  reaches canonicalization anyway (it replays the stored args). Returns
 *  `null` when neither is present; `consumeApproval` turns that into a
 *  `confirmation_missing_id` rejection. */
function confirmIdFromInvocation(invocation: ToolInvocation): string | null {
  const fromMeta = invocation.meta?.[SK_CONFIRM_ID_META_KEY];
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  return confirmIdFromArgs(invocation.args as Record<string, unknown>);
}

/** True when this dispatch would hand a conversation tool the MCP stub context
 *  (empty draft, no-op `setDraft`) instead of a live conversation draft. Chat
 *  keeps the real `conversationCtx`, so it is never true there. */
function usesStubDraftContext(deps: DispatchDeps, invocation: ToolInvocation): boolean {
  return invocation.surface !== "chat" && deps.buildMcpStubCtx !== undefined;
}

/** `ToolDescriptor.inputSchema` is deliberately `unknown`: Zod for
 *  conversation tools, JSON Schema for the MCP-native static ones. Only the
 *  former can canonicalize, and only it answers `safeParse`. */
function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return typeof (schema as { safeParse?: unknown } | null)?.safeParse === "function";
}

type CanonicalArgs =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly message: string; readonly details: unknown };

/**
 * Parse the invocation args through the tool's own schema, once, before
 * anything reads them.
 *
 * The policy gate, the approval record, and the executor must all see the
 * SAME value. Reading the raw args in the gate and the parsed args in the
 * executor made schema defaults invisible to policy — a `run_workflow`
 * without an explicit `environment` gated as if it targeted prod, because
 * the `.default("dev")` only landed inside `execute()`.
 *
 * This parse is AUTHORITATIVE, not exclusive. `requestApproval` persists its
 * OUTPUT, and an approved replay feeds that stored value straight back to the
 * executor — which re-parses, because most registry executors are also
 * reachable without this dispatcher (`conversations/direct-invoke.ts`, the
 * connector import route, the AI SDK's own tool boundary) and depend on their
 * schema for defaults. The canonical value therefore crosses the schema twice
 * on the approval path.
 *
 * That is safe only while every `inputSchema` is parse-idempotent —
 * `parse(parse(x))` deep-equals `parse(x)`. Validation, defaults, coercions
 * and `.catch()` satisfy this by construction; a `transform` does not.
 * `conversations/tools/schema-idempotence.test.ts` enforces it for the whole
 * registry, so a non-idempotent transform fails CI instead of silently
 * rewriting the payload an operator already approved.
 */
function canonicalizeArgs(schema: unknown, raw: Record<string, unknown>): CanonicalArgs {
  if (!isZodSchema(schema)) return { ok: true, args: raw };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Project the issues rather than forwarding them: a Zod issue can echo the
    // rejected value, and these args may carry secrets.
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
  // A non-object schema carries no named args to canonicalize; the raw
  // record is already the invocation's arg map.
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: true, args: raw };
  }
  return { ok: true, args: data as Record<string, unknown> };
}

/**
 * POLICY_DENIED for a call the RBAC gate refused.
 *
 * When the refusal lands on a call whose single-use approval was already
 * burned by the confirm step, the row is anchored on the APPROVAL_REQUESTED
 * lifecycle (`resource_type` + `resource_id` = the approval) so the
 * contradiction — an approval opened, then its confirmed replay denied — is a
 * single JOIN rather than two unrelated rows. The RBAC resource, when there is
 * one, moves into metadata so nothing is lost.
 */
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
        // Same fingerprint the APPROVAL_REQUESTED row and tool_approvals
        // carry — a denied intent joins forensically with any approval
        // lifecycle for the identical call. Hash only, never raw values.
        // NOTE on canonicalization: RBAC runs BEFORE canonicalizeArgs (a
        // deliberate pipeline order — authorization precedes input
        // validation), so a FIRST-CALL denial hashes the raw invocation
        // args (no approval row exists to correlate with anyway), while a
        // confirmed-REPLAY denial hashes `claim.args`, which are already
        // canonical and therefore match the approval's args_hash.
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

/**
 * Resolve a `confirm_before_execution` gate — portal-only. The model is never
 * the approver, and nothing inside this call can grant the approval.
 *
 * The approval is minted UNGRANTED and its `approval_url` is handed back with a
 * `needs_confirm` envelope. A HUMAN grants it out of band at that link; a later
 * `confirm_tool_call` / `ask_user_confirm` carrying the `tool_call_id` then
 * TRIGGERS the granted row (dispatcher step 3), claiming it and replaying the
 * args the engine persisted here. The handle claims nothing until a person has
 * granted it — `consumeApproval` refuses an ungranted row by construction.
 */
async function gateConfirm(
  deps: DispatchDeps,
  toolName: string,
  invocation: ToolInvocation,
  confirm: ConfirmEnvelope,
  args: { execArgs: Record<string, unknown> },
): Promise<ToolEnvelope> {
  // Persist the args under the minted tool_call_id, mint the portal link, and
  // record APPROVAL_REQUESTED. The re-issue carries the id back; it never
  // re-transmits the payload. The dispatcher has no ambient execution
  // environment: a tool that targets one (`run_workflow`) carries it as an
  // argument, so it is already covered by the encrypted, hash-bound payload.
  const { approval_url } = await requestApproval({
    db: deps.db,
    principal: deps.principal,
    approval_id: confirm.tool_call_id,
    tool: toolName,
    surface: invocation.surface,
    via: invocation.surface,
    // The rule the gate just enforced, not a fixed label.
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

  // 1. Resolve.
  const entry = deps.registry.get(invocation.name, {
    surface: invocation.surface,
    ...(deps.mcpMode !== undefined ? { mcpMode: deps.mcpMode } : {}),
    ...(deps.loadedSkills !== undefined ? { loadedSkills: deps.loadedSkills } : {}),
    ...(deps.readOnly !== undefined ? { readOnly: deps.readOnly } : {}),
  });

  // Initialized with an unreachable placeholder so TS narrowing through
  // the nested confirm / rbac / policy / execute branches stays happy.
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
  } else if (usesStubDraftContext(deps, invocation) && entry.descriptor.requires_draft) {
    // Draft-dependency guard — an AVAILABILITY fact, so it belongs in the
    // visibility step and not in the executor. Off the chat surface the
    // dispatcher runs conversation tools against the MCP stub context, whose
    // `getDraft()` returns an EMPTY draft and whose `setDraft()` is a no-op
    // (see mcp/adapter.ts#buildMcpStubCtx). A tool that needs the live
    // conversation draft (`requires_draft`) would therefore operate on nothing
    // and hand back a misleading success. Deciding it here — before the confirm
    // gate — also means such a tool never mints an approval on MCP: an approval
    // whose confirmed replay can only answer `not_available_on_surface` would
    // burn a handle and record APPROVAL_APPROVED for a call that never ran.
    envelope = {
      status: "not_available_on_surface",
      reason: DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON,
    };
    decisionLabel = "not_available_on_surface";
  } else {
    // The confirm markers belong to no tool schema. Read them off the RAW
    // invocation, before canonicalization would reject them.
    const confirmed = isConfirmedRequest(invocation.args, invocation.meta);
    let halted = false;
    let execArgs: Record<string, unknown> = invocation.args;
    let canonicalizedForResource = false;
    // Set once the confirm step burned a handle. From here on the call is
    // CLAIMED, not yet approved: it still has to survive rbac + policy, and
    // every denial in between anchors its audit row on this approval.
    let claimed: ClaimedApproval | null = null;

    // 3. Confirm — claim the approval and replay the args it was granted for.
    //    A confirmation carries an id and NOTHING else (the MCP responder's
    //    published schema has no `arguments` property), so the stored payload
    //    is the only payload there is: parsing the client's empty arg map
    //    against the tool's schema would reject every approved call with
    //    `invalid_args`. Runs before RBAC so the permission check evaluates
    //    the args that actually reach the executor.
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

    // 4. RBAC — descriptor-declared permission, evaluated BEFORE canonicalization
    //    and BEFORE the policy gate. Authorization is logically prior to input
    //    validation: an unauthorized caller must get `policy_denied` whether or
    //    not their args are well-formed — never `invalid_args` (which would both
    //    leak the arg schema and skip the denial audit row), never a confirm
    //    prompt, never an `APPROVAL_REQUESTED`. Resource extraction reads plain
    //    top-level ids (connector_id, execution id, workflow slug) that are
    //    identical raw or parsed, so running before canonicalize is safe. On the
    //    confirmed replay `execArgs` is already `claim.args` (canonical). RBAC is
    //    re-evaluated on that replay too — a grant can be revoked between request
    //    and approval.
    if (!halted && entry.descriptor.rbac) {
      let resource = entry.descriptor.rbac.resource
        ? entry.descriptor.rbac.resource(execArgs)
        : undefined;
      const executor = entry.executor;
      if (isConversationExecutor(executor) && executor.tool?.permission?.resolveResourceId) {
        // Resolve the same defaults the executor receives (especially the
        // environment). Invalid input still gets the ordinary permission
        // check below before the validation error is exposed. Confirmed args
        // are already canonical and must not be transformed a second time.
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
        halted = true;
      }
    }

    // 5. Canonicalize — after RBAC, before policy and before the approval record.
    //    NOT on a replay: `claim.args` was canonicalized when the approval was
    //    granted, and `requestApproval` stored it verbatim (AES-GCM, AAD- and
    //    hash-bound). Parsing it again would run the schema's transforms a
    //    second time on their own output — safe only for transforms that happen
    //    to be idempotent, and a silent rewrite of the approved payload for any
    //    that are not.
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
      // Skip remainder of the pipeline; the final log emit below still
      // fires so observability sees the rejection.
    } else {
      // 6. Policy. The confirmation lives on `meta` here because `args` is
      //    now the canonical, marker-free payload — the gate must still see
      //    that this call was approved, and it must still be able to reject
      //    the call outright (draft_write on MCP) even when it carries one.
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
        // A claim that got this far burned its single-use handle and will never
        // execute. Close the lifecycle on the approval id — a spent handle whose
        // audit trail stops at APPROVAL_REQUESTED is indistinguishable from an
        // approved write whose APPROVAL_APPROVED row was lost.
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
        // Portal-only: mint the ungranted approval and hand back its
        // `approval_url`. A human grants it out of band; a later confirm marker
        // (step 3) triggers the granted row. Nothing here grants it.
        envelope = await gateConfirm(deps, entry.descriptor.name, invocation, policy.envelope, {
          execArgs,
        });
        decisionLabel = "needs_confirm";
        halted = true;
      }

      if (halted) {
        // The gate answered for this call (pending approval, decline, or a
        // terminal fault). The final log emit below still fires.
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
        // 7. Approve. The claim survived rbac + policy — record it. A failed
        //    audit write must not become an unaudited approved execution.
        envelope = {
          status: "error",
          error_code: "approval_audit_failed",
          message: `Confirmation ${claimed.approval_id} could not be recorded in the audit log; nothing was executed. Re-issue the original call to obtain a fresh confirmation.`,
        };
        decisionLabel = "approval_audit_failed";
      } else {
        // 8. Execute.
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

  // 10. Log one envelope per dispatch. Include `reason` when the
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
