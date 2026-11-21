import type { ToolModeRule, ToolPolicyMode } from "../../tools/types.ts";
import { DANGEROUS_TOOLS_SET } from "../dangerous-tools.ts";

export function personCoverRule(p: {
  readonly tool: string;
  readonly ask_before_writing: boolean;
  readonly instruction_covered: boolean;
  readonly rule_covered: boolean;
  readonly task_run: boolean;
  readonly override: ToolPolicyMode | null;
}): Extract<ToolModeRule, "user_instruction" | "standing_rule"> | null {
  if (DANGEROUS_TOOLS_SET.has(p.tool)) return null;
  if (p.override === "confirm_before_execution") return null;
  if (p.rule_covered) return "standing_rule";
  if (p.instruction_covered && !p.ask_before_writing) return "user_instruction";
  return null;
}
