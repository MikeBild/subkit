import type { ToolResultPause } from "../conversations/tools/index.ts";

export type ToolSurface = "chat" | "mcp";

export type ToolPolicyMode = "no_confirm" | "confirm_before_execution" | "confirm_after_execution";

export interface ToolPolicies {
  [toolName: string]: ToolPolicyMode;
}

export type PermissionMode = "auto" | "ask" | "plan" | "yolo";

export type ToolModeRule =
  | "inline_credential"
  | "connector_trust"
  | "authority_covered"
  | "user_instruction"
  | "standing_rule"
  | "never_gate"
  | "permission_mode"
  | "conversation_override"
  | "computed_from_input"
  | "tool_default"
  | "category_default";

export type ToolCategory = "draft_write" | "tenant_read" | "tenant_write";

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly inputSchema: unknown;
  readonly disabled?: { readonly reason: string };
  readonly requires_skill?: string;
  readonly authoring_only?: boolean;
  readonly requires_draft?: boolean;
  readonly rbac?: {
    readonly permission: string;
    readonly additional_permissions?: readonly string[];
    readonly resource?: (
      args: Record<string, unknown>,
    ) => { readonly type: string; readonly id: string } | null;
  };
}

export type ConfirmReason = ToolModeRule | "held_writes";

export interface ConfirmEnvelope {
  readonly tool: string;
  readonly pending_output: Record<string, unknown> | null;
  readonly policy_mode: "confirm_before_execution";
  readonly reason: ConfirmReason;
  readonly tool_call_id: string;
  readonly approval_url?: string | null;
  readonly resume: string;
}

export type ToolEnvelope =
  | {
      readonly status: "ok";
      readonly data: unknown;
      readonly pause?: ToolResultPause;
      readonly committed_workflow_id?: string;
    }
  | {
      readonly status: "error";
      readonly error_code: string;
      readonly message: string;
      readonly details?: unknown;
      readonly next_best_actions?: readonly string[];
    }
  | {
      readonly status: "needs_confirm";
      readonly confirm: ConfirmEnvelope;
    }
  | {
      readonly status: "paused";
      readonly pause: ToolResultPause;
    }
  | {
      readonly status: "not_available_on_surface";
      readonly reason: string;
    };

export interface ToolInvocation {
  readonly surface: ToolSurface;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}
