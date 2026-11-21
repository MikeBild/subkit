import { createHash } from "node:crypto";

export const COMMAND_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface WorkflowCommandOccurrence {
  execution_id: string;
  step_id: string;
  call_path: readonly string[];
  iteration_path: string;
  effect_index: number;
}

export interface ConversationCommandOccurrence {
  owner_kind: "task_run" | "conversation";
  owner_id: string;
  tool_call_id: string;
}

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function effectIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid effect index");
  return value;
}

export function workflowCommandId(occurrence: WorkflowCommandOccurrence): string {
  return digest([
    "workflow",
    occurrence.execution_id,
    occurrence.step_id,
    [...occurrence.call_path],
    occurrence.iteration_path,
    effectIndex(occurrence.effect_index),
  ]);
}

export function conversationCommandId(occurrence: ConversationCommandOccurrence): string {
  return digest([occurrence.owner_kind, occurrence.owner_id, occurrence.tool_call_id]);
}

export function isCommandId(value: string): boolean {
  return COMMAND_ID_PATTERN.test(value);
}
