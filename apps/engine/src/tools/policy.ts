import { decideToolMode } from "../conversations/public/policy.ts";
import type {
  ConfirmEnvelope,
  ConfirmReason,
  PermissionMode,
  ToolCategory,
  ToolModeRule,
  ToolPolicies,
  ToolPolicyMode,
  ToolSurface,
} from "./types.ts";

export type PolicySkipReason =
  | "mode_not_confirm_before_execution"
  | "prior_approval_present"
  | "confirmed_marker";

export type PolicyDecision =
  | { kind: "proceed"; mode: ToolPolicyMode; rule: ToolModeRule; skip_reason: PolicySkipReason }
  | { kind: "needs_confirm"; mode: "confirm_before_execution"; rule: ToolModeRule }
  | { kind: "not_available_on_surface"; mode: ToolPolicyMode; rule: ToolModeRule; reason: string };

export const MCP_ELICITATION_BLURB =
  "the engine collects any input it needs — forms, OAuth authorization — through the authoring conversation in this client, so the operator stays in the chat";

export const DRAFT_WRITE_MCP_UNAVAILABLE_REASON = `This tool mutates a conversation-scoped working draft and is only available inside an authoring conversation. Author from the sk CLI (\`sk workflows --help\`, \`sk connectors --help\`), which edits definitions from a file you can read. Over MCP, conversation_start opens an authoring conversation when the credential carries the mcp:authoring scope; ${MCP_ELICITATION_BLURB}.`;

export const CONVERSATION_TOOL_MCP_UNAVAILABLE_REASON =
  "Authoring is not enabled for this credential. Definitions — workflows, connectors, knowledge sources, skills — are authored through the sk CLI (`sk workflows --help`, `sk connectors --help`), where the change is a file you can read before it is applied. To author over MCP instead, the credential must carry the mcp:authoring scope.";

export const DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON = `This tool operates on a conversation-scoped working draft and is only available inside an authoring conversation. Author from the sk CLI (\`sk workflows --help\`, \`sk connectors --help\`), which edits definitions from a file you can read. Over MCP, conversation_start opens an authoring conversation when the credential carries the mcp:authoring scope; ${MCP_ELICITATION_BLURB}.`;

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

export function isConfirmedRequest(
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): boolean {
  return isConfirmed(args, meta);
}

export function confirmIdFromArgs(args: Record<string, unknown>): string | null {
  const v = args[ARGS_CONFIRM_ID_KEY];
  return typeof v === "string" && v.length > 0 ? v : null;
}

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
  readonly connector_trust?: boolean;
  readonly authority_covered?: boolean;
  readonly prior_approval?: boolean;
  readonly execution_data_transfer?: boolean;
  readonly task_run?: boolean;
}

export function policyDecide(input: PolicyDecideInput): PolicyDecision {
  const { mode, rule } = decideToolMode({
    tool: input.tool,
    category: input.category,
    input: input.args,
    overrides: input.overrides ?? {},
    permission_mode: input.permission_mode ?? null,
    ...(input.connector_trust ? { connector_trust: true } : {}),
    ...(input.authority_covered ? { authority_covered: true } : {}),
    ...(input.execution_data_transfer ? { execution_data_transfer: true } : {}),
    ...(input.task_run ? { task_run: true } : {}),
  });

  if (input.category === "draft_write" && input.surface === "mcp") {
    return {
      kind: "not_available_on_surface",
      mode,
      rule,
      reason: DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
    };
  }

  if (mode !== "confirm_before_execution") {
    return { kind: "proceed", mode, rule, skip_reason: "mode_not_confirm_before_execution" };
  }

  if (input.prior_approval === true) {
    return { kind: "proceed", mode, rule, skip_reason: "prior_approval_present" };
  }

  if (isConfirmed(input.args, input.meta)) {
    return { kind: "proceed", mode, rule, skip_reason: "confirmed_marker" };
  }

  return { kind: "needs_confirm", mode, rule };
}

export function confirmEnvelopeFor(p: {
  readonly tool: string;
  readonly pending_output: Record<string, unknown> | null;
  readonly rule: ConfirmReason;
  readonly approval_id: string;
  readonly approval_url: string | null;
  readonly surface: ToolSurface;
}): ConfirmEnvelope {
  return {
    tool: p.tool,
    pending_output: p.pending_output,
    policy_mode: "confirm_before_execution",
    reason: p.rule,
    tool_call_id: p.approval_id,
    approval_url: p.approval_url,
    resume:
      p.surface === "mcp"
        ? "A person must grant the approval at approval_url. Only then call confirm_tool_call with tool and confirm_id = tool_call_id. This triggers the stored call; it cannot approve it."
        : "The operator answers the emitted ask_user_confirm; the engine then performs the call itself.",
  };
}

export { ARGS_CONFIRM_ID_KEY, ARGS_CONFIRM_KEY, SK_CONFIRM_ID_META_KEY, SK_CONFIRM_META_KEY };
