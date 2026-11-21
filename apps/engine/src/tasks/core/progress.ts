import { workflowJsonDigest } from "../../workflows/canonical-json.ts";

export const TASK_RUN_ACTING_TOOLS: readonly string[] = [
  "run_workflow",
  "call_connector",
  "probe_connector",
  "browser_open",
  "browser_press",
  "browser_fill",
  "computer_press",
  "computer_select",
  "computer_set_value",
  "computer_type",
  "computer_key",
  "files_write",
  "files_mkdir",
  "files_move",
  "files_trash",
];

export interface TaskPlaybookProgress {
  ready_steps: number;
  fresh_evidence_ids: readonly string[];
  results: readonly string[];
}

export interface TaskRunToolCall {
  id: string;
  tool: string;
  outcome: string | null;
}

export interface TaskRunProgressStep {
  progress_marks: string[];
  progressed: boolean;
}

export function taskPlaybookProgressMarks(playbook: TaskPlaybookProgress): string[] {
  return [
    ...Array.from({ length: playbook.ready_steps }, (_, index) => `ready:${index + 1}`),
    ...playbook.fresh_evidence_ids.map((id) => `evidence:${id}`),
    ...playbook.results.map((result) => `result:${workflowJsonDigest(result)}`),
  ];
}

export function taskRunToolCallActs(call: Pick<TaskRunToolCall, "tool" | "outcome">): boolean {
  if (call.outcome !== "ok") return false;
  return call.tool.startsWith("wf_") || TASK_RUN_ACTING_TOOLS.includes(call.tool);
}

export function taskRunCallMarks(calls: readonly TaskRunToolCall[]): string[] {
  return calls.filter(taskRunToolCallActs).map((call) => `call:${call.id}`);
}

export function taskRunProgress(
  seen: readonly string[],
  observed: readonly string[],
): TaskRunProgressStep {
  const progress_marks = [...new Set([...seen, ...observed])];
  return { progress_marks, progressed: progress_marks.length > new Set(seen).size };
}
