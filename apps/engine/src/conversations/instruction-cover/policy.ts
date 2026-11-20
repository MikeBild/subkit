import type { PermissionMode, ToolModeRule, ToolPolicyMode } from "../../tools/types.ts";
import { DANGEROUS_TOOLS_SET } from "../dangerous-tools.ts";

export function personCoverRule(p: {
  readonly tool: string;
  readonly permission_mode: PermissionMode | null;
  readonly instruction_covered: boolean;
  readonly rule_covered: boolean;
  readonly task_run: boolean;
  readonly override: ToolPolicyMode | null;
}): Extract<ToolModeRule, "user_instruction" | "standing_rule"> | null {
  if (p.task_run || DANGEROUS_TOOLS_SET.has(p.tool)) return null;
  if (p.override === "confirm_before_execution") return null;
  if (p.rule_covered && (p.permission_mode === "auto" || p.permission_mode === "ask")) {
    return "standing_rule";
  }
  if (p.instruction_covered && p.permission_mode === "auto") return "user_instruction";
  return null;
}
