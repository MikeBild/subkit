// The confirm gate — a pure function that decides whether a tool call
// should proceed, pause for confirmation, or be rejected as unavailable
// on this surface. There is exactly one: every surface (dispatcher, chat
// fast-path, the synthetic `mcp_<ns>__<tool>` palette) calls it, and none
// of them re-derives the decision.
//
// Audit emission (APPROVAL_REQUESTED / APPROVAL_APPROVED) lives in
// `tools/approval.ts`, NOT here — `policyDecide()` is sync, deterministic,
// and has no I/O.

import {
  buildPendingOutputForTool,
  decideToolMode,
  type PermissionMode,
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
// `elicitation/create` — the hosted flagship clients do not advertise that
// capability, so the engine collects input through the authoring conversation
// (model-relayed prompts; OAuth via an authorize link). Keep the wording
// capability-agnostic.
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
export const DRAFT_WRITE_MCP_UNAVAILABLE_REASON = `This tool mutates a conversation-scoped working draft and is only available inside an authoring conversation. Author from the sk CLI (\`sk workflows --help\`, \`sk connectors --help\`), which edits definitions from a file you can read. Over MCP, conversation_start opens an authoring conversation when the credential carries the mcp:authoring scope; ${MCP_ELICITATION_BLURB}.`;

/**
 * Reason surfaced when a `conversation_*` session tool is called by a
 * credential that does not carry authoring.
 *
 * Authoring over MCP is opt-in per credential, so this is a real refusal, not
 * a hint about a missing draft. It names the CLI first because that is the
 * path that always works, and the scope second so an operator who does want
 * MCP authoring knows exactly what to grant.
 */
export const CONVERSATION_TOOL_MCP_UNAVAILABLE_REASON =
  "Authoring is not enabled for this credential. Definitions — workflows, connectors, knowledge sources, skills — are authored through the sk CLI (`sk workflows --help`, `sk connectors --help`), where the change is a file you can read before it is applied. To author over MCP instead, the credential must carry the mcp:authoring scope.";

/**
 * Reason surfaced when a draft-DEPENDENT tool (`requires_draft`) is reached
 * on the MCP stub-context path. Distinct from
 * `DRAFT_WRITE_MCP_UNAVAILABLE_REASON` because such a tool may be
 * `tenant_read`/`tenant_write` (not `draft_write`) yet still needs a live
 * conversation draft for its DATA — running it against the empty MCP stub
 * draft would be a silent no-op. The dispatcher returns this instead.
 */
export const DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON = `This tool operates on a conversation-scoped working draft and is only available inside an authoring conversation. Author from the sk CLI (\`sk workflows --help\`, \`sk connectors --help\`), which edits definitions from a file you can read. Over MCP, conversation_start opens an authoring conversation when the credential carries the mcp:authoring scope; ${MCP_ELICITATION_BLURB}.`;

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

/** The approval id a confirmed re-issue carried inside its args. Chat callers
 *  have no transport `_meta`, so this is their only channel; the dispatcher
 *  layers the `_meta.sk_confirm_id` alias on top for MCP. `null` when absent —
 *  `consumeApproval` turns that into `confirmation_missing_id`. */
export function confirmIdFromArgs(args: Record<string, unknown>): string | null {
  const v = args[ARGS_CONFIRM_ID_KEY];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Declare the confirm markers on a JSON-Schema the tool itself authored.
 *
 * ONLY for the synthetic external-MCP palette (`mcp_<ns>__<tool>`). Those tools
 * proxy a REMOTE server: the engine cannot perform the call on the operator's
 * behalf from a harness resume, so the model must relay the approval — and it
 * relays an ID, not a decision. `__policy_confirmed` alone proceeds nowhere:
 * `consumeApproval` demands the single-use `__policy_confirm_id`, which the
 * engine minted and the operator's confirmation released. A parameterless
 * remote tool publishes `{properties:{}, additionalProperties:false}`, leaving
 * the model no legal slot for that id — publishing a gate the caller cannot
 * resolve is the same defect as reading a confirmation off transport `_meta` no
 * model-driven client can set.
 *
 * NOT for in-repo conversation tools, and NOT for `wf_<slug>`. Both are
 * performed by the HARNESS after the operator answers the elicitation the gate
 * raised (`persistence/auto-persist.ts`), so the model has nothing to carry
 * back. A model-settable approval marker there is an escape hatch around the
 * only human in the loop — `sdk-wrap/invoke.ts` publishes each tool's own
 * schema, sealed `.strict()`, and reads no marker off it.
 *
 * Only the properties are added; `required` stays as authored, so an
 * unconfirmed first call is still valid.
 */
export function withConfirmMarkerProperties(schema: unknown): Record<string, unknown> {
  const base =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : { type: "object", properties: {} };
  const properties =
    base.properties && typeof base.properties === "object" && !Array.isArray(base.properties)
      ? (base.properties as Record<string, unknown>)
      : {};
  return {
    ...base,
    properties: {
      ...properties,
      [ARGS_CONFIRM_KEY]: {
        type: "boolean",
        description:
          "Set to true ONLY when re-issuing a call the operator explicitly approved. Must accompany __policy_confirm_id.",
      },
      [ARGS_CONFIRM_ID_KEY]: {
        type: "string",
        description:
          "The confirm_id the engine returned with the pending or preview envelope. The engine replays the arguments it already holds under this id.",
      },
    },
  };
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

  // We compute the enforced mode for EVERY category (no `tenant_read`
  // shortcut): a tenant_read tool with a `computeModeFromInput` predicate
  // (e.g. `probe_connector` POST against prod) still resolves its real mode,
  // so the audit row and the MCP-gate invariant below both see the truth.
  // `decideToolMode`, not the `resolveToolMode` projection: the envelope must
  // report the rule that was ENFORCED, and the projection throws it away.
  const decision = decideToolMode({
    tool: input.tool,
    category: input.category,
    input: input.args,
    overrides: input.overrides ?? {},
    permission_mode: input.permission_mode ?? null,
  });

  if (decision.mode !== "confirm_before_execution") return { kind: "proceed" };

  // MCP: the CLIENT's native `destructiveHint` dialog is the human gate.
  // Every MCP-reachable tool that can resolve to `confirm_before_execution`
  // advertises `destructiveHint:true` (`mcp/capabilities/tool-meta.ts`; pinned
  // exhaustively by `mcp/tests/confirm-gate-invariant.test.ts`, which sweeps
  // the whole registry — `tools-list.test.ts` only spot-checks a few tools),
  // so a trusted client (claude.ai,
  // ChatGPT) renders a blocking, per-call, model-unbypassable approval BEFORE
  // the call reaches the engine — empirically verified against both clients.
  // A second server-side confirm would be redundant AND has no in-band grant
  // channel over MCP (elicitation is advertised-but-unfulfilled), so it could
  // only dead-end the write. Chat is unaffected: it carries a real user
  // principal and gates via the HTTP `ask_user_confirm` elicitation route.
  if (input.surface === "mcp") return { kind: "proceed" };

  // The caller already confirmed (or yolo'd around) the gate.
  if (isConfirmed(input.args, input.meta)) return { kind: "proceed" };

  // The envelope carries a structured preview of what the call will do,
  // never the payload itself: the dispatcher persists the canonical args
  // under `tool_call_id` and the re-issue replays them from there. Echoing
  // them back asked the caller to re-transmit a payload byte-exactly — a
  // ~50KB markdown body no model can reproduce.
  return {
    kind: "needs_confirm",
    envelope: {
      tool: input.tool,
      pending_output: buildPendingOutputForTool(input.tool, input.args),
      policy_mode: "confirm_before_execution",
      reason: decision.rule,
      tool_call_id: crypto.randomUUID(),
      // Only the chat surface reaches this envelope: MCP collapses to `proceed`
      // above (the client's destructiveHint dialog is the gate). Chat gates via
      // the emitted `ask_user_confirm` HTTP elicitation, answered by the real
      // user principal; the engine then performs the call itself.
      resume:
        "The operator answers the emitted ask_user_confirm; the engine then performs the call itself.",
    },
  };
}

export { ARGS_CONFIRM_ID_KEY, ARGS_CONFIRM_KEY, SK_CONFIRM_ID_META_KEY, SK_CONFIRM_META_KEY };
