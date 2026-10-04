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
}

export function policyDecide(input: PolicyDecideInput): PolicyDecision {
  if (input.category === "draft_write" && input.surface === "mcp") {
    return {
      kind: "not_available_on_surface",
      reason: DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
    };
  }

  const decision = decideToolMode({
    tool: input.tool,
    category: input.category,
    input: input.args,
    overrides: input.overrides ?? {},
    permission_mode: input.permission_mode ?? null,
    ...(input.connector_trust ? { connector_trust: true } : {}),
  });

  if (decision.mode !== "confirm_before_execution") return { kind: "proceed" };

  if (isConfirmed(input.args, input.meta)) return { kind: "proceed" };

  return {
    kind: "needs_confirm",
    envelope: {
      tool: input.tool,
      pending_output: buildPendingOutputForTool(input.tool, input.args),
      policy_mode: "confirm_before_execution",
      reason: decision.rule,
      tool_call_id: crypto.randomUUID(),
      resume:
        input.surface === "mcp"
          ? "A person must grant the approval at approval_url. Only then call confirm_tool_call with tool and confirm_id = tool_call_id. This triggers the stored call; it cannot approve it."
          : "The operator answers the emitted ask_user_confirm; the engine then performs the call itself.",
    },
  };
}

export { ARGS_CONFIRM_ID_KEY, ARGS_CONFIRM_KEY, SK_CONFIRM_ID_META_KEY, SK_CONFIRM_META_KEY };
