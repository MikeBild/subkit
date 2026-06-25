// Unified policy gate — pure function that decides whether a tool call
// should proceed, pause for confirmation, or be rejected as unavailable
// on this surface. Replaces both:
//
//   conversations/tool-policies.ts::resolveToolMode()  (chat side)
//   mcp/capabilities/policy-gate.ts::gateTenantToolCall() (MCP side)
//
// Audit emission (APPROVAL_REQUESTED / APPROVAL_APPROVED) lives in the
// dispatcher, NOT here — `policyDecide()` is sync, deterministic, and
// has no I/O.

import {
  type PermissionMode,
  resolveToolMode,
  type ToolPolicies,
} from "../conversations/tool-policies.ts";
import type { ConfirmEnvelope, ToolCategory, ToolSurface } from "./types.ts";

export type PolicyDecision =
  | { kind: "proceed" }
  | { kind: "needs_confirm"; envelope: ConfirmEnvelope }
  | { kind: "not_available_on_surface"; reason: string };

/**
 * Canonical one-line description of how the engine surfaces interactive
 * prompts on an MCP client. Pinned here as the single source of truth so
 * the `conversation_start` / `conversation_append` tool descriptions,
 * the `DRAFT_WRITE_MCP_UNAVAILABLE_REASON` below, and any tests stay in
 * lock-step. Reference this constant rather than re-typing the phrase.
 */
// NB: despite the name, this must NOT promise protocol-level MCP
// `elicitation/create` — the hosted clients (claude.ai, chatgpt.com) do
// not advertise that capability, so the engine collects input through the
// authoring conversation (model-relayed prompts; OAuth via an authorize
// link). Keep the wording capability-agnostic.
export const MCP_ELICITATION_BLURB =
  "the engine collects any input it needs — forms, OAuth authorization — through the authoring conversation in this client, so the operator stays in the chat";

/**
 * Reason string surfaced when a `draft_write` tool is reached on the
 * MCP surface. Exported so the `tools/list` `disabled` badge
 * (`tools/providers/conversation.ts#describeDisabled`) and this
 * decision path emit the SAME actionable message — naming
 * `conversation_start` and explaining that forms and OAuth prompts are
 * surfaced via MCP elicitation. Keep the two surfaces in lock-step by
 * sourcing the text here.
 */
export const DRAFT_WRITE_MCP_UNAVAILABLE_REASON = `This tool mutates a conversation-scoped working draft and is only available inside an authoring conversation. Call conversation_start to begin connector/workflow authoring; ${MCP_ELICITATION_BLURB}.`;

/** Confirmation marker the client sets when re-issuing a previously
 *  paused call. Two aliases for symmetry with the legacy sdk-wrap /
 *  policy-gate code: `_meta.sk_confirm` on MCP, `__policy_confirmed`
 *  inside args on chat. The corresponding ID keys carry the original
 *  APPROVAL_REQUESTED tool_call_id back so APPROVAL_APPROVED can join
 *  the lifecycle. */
const SK_CONFIRM_META_KEY = "sk_confirm";
const ARGS_CONFIRM_KEY = "__policy_confirmed";
const SK_CONFIRM_ID_META_KEY = "sk_confirm_id";
const ARGS_CONFIRM_ID_KEY = "__policy_confirm_id";

function isConfirmed(
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): boolean {
  if (meta && meta[SK_CONFIRM_META_KEY] === true) return true;
  if (args[ARGS_CONFIRM_KEY] === true) return true;
  return false;
}

/** Public re-export of the confirm-marker check so the dispatcher can
 *  reuse the same predicate without re-declaring the constants. */
export function isConfirmedRequest(
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): boolean {
  return isConfirmed(args, meta);
}

export interface PolicyDecideInput {
  readonly tool: string;
  readonly category: ToolCategory;
  readonly surface: ToolSurface;
  readonly args: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
  readonly permission_mode?: PermissionMode | null;
  readonly overrides?: ToolPolicies;
}

export function policyDecide(input: PolicyDecideInput): PolicyDecision {
  // draft_write on MCP — surface this honestly with a structured,
  // actionable message rather than silently omitting or running the
  // conversation-shaped ask_user_confirm gate against a non-conversation
  // surface. The message names `conversation_start` as the entry tool
  // so the client can funnel the operator into an authoring conversation
  // — where forms and OAuth prompts are surfaced directly via MCP
  // elicitation.
  if (input.category === "draft_write" && input.surface === "mcp") {
    return {
      kind: "not_available_on_surface",
      reason: DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
    };
  }

  // Note: we DO NOT shortcut on `category === "tenant_read"` here.
  // The legacy MCP gate (mcp/capabilities/policy-gate.ts:84) did, which
  // meant a tenant_read tool with a computeModeFromInput predicate
  // (e.g. probe_connector POST against prod) silently bypassed the
  // confirmation on MCP while gating correctly on chat. The unified
  // policy lets resolveToolMode decide for every category — tenant_read
  // tools without dynamic predicates still resolve to no_confirm, so
  // the common case is unchanged; the dangerous tenant_read+escalation
  // case is now consistent.
  const mode = resolveToolMode({
    tool: input.tool,
    category: input.category,
    input: input.args,
    overrides: input.overrides ?? {},
    permission_mode: input.permission_mode ?? null,
  });

  if (mode !== "confirm_before_execution") return { kind: "proceed" };

  // The caller already confirmed (or yolo'd around) the gate.
  if (isConfirmed(input.args, input.meta)) return { kind: "proceed" };

  // Strip the args-side confirmation marker before echoing the target
  // back — the client should re-submit the original payload, not the
  // (already-rejected) confirmation form.
  const echoArgs: Record<string, unknown> = { ...input.args };
  delete echoArgs[ARGS_CONFIRM_KEY];

  return {
    kind: "needs_confirm",
    envelope: {
      tool: input.tool,
      args: echoArgs,
      policy_mode: "confirm_before_execution",
      reason: "destructive_action",
      tool_call_id: crypto.randomUUID(),
      resume:
        input.surface === "mcp"
          ? "Elicitation-capable clients are prompted to approve in-band automatically. Otherwise approve by calling confirm_tool_call with { tool, arguments, confirm_id: <this tool_call_id> }."
          : "Resume via ask_user_confirm reply with confirmed=true.",
    },
  };
}

export { ARGS_CONFIRM_ID_KEY, ARGS_CONFIRM_KEY, SK_CONFIRM_ID_META_KEY, SK_CONFIRM_META_KEY };
