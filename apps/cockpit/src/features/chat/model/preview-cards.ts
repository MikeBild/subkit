import type { ToolPart } from "@/components/ai-elements/tool";
import {
  type ConversationReference,
  isMentionableLabel,
  mentionTokenText,
} from "@/features/chat/model/mentions";
import type { Translate } from "@/lib/i18n";
import { asToolPart, toolNameOf } from "./tool-parts";

export const PREVIEW_STAGES = ["schema_only", "redacted_fixture", "person_verified"] as const;

export type PreviewStage = (typeof PREVIEW_STAGES)[number];

export interface ChatWorkflowRef {
  id: string;
  label: string | null;
}

export interface ChatSensitivePreview {
  passed: boolean;
  stage: PreviewStage;
  steps: number;
  expressions: number;
  compileErrors: number;
  requestsHeld: boolean;
  saveRequired: boolean;
  workflow: ChatWorkflowRef | null;
}

export interface ChatJudgeFindings {
  verdict: "partial" | "failed";
  reason: string;
  missing: string[];
  workflow: ChatWorkflowRef | null;
}

export type FindingState = "open" | "handed" | "kept";

const RESULT_STATES = new Set<ToolPart["state"]>(["output-available", "output-error"]);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

function dryRunData(tool: ToolPart): Record<string, unknown> | null {
  if (toolNameOf(tool) !== "dry_run_workflow" || !RESULT_STATES.has(tool.state)) return null;
  const output = tool.output;
  if (!record(output)) return null;
  return record(output.data) ? output.data : output;
}

export function workflowRefOf(data: Record<string, unknown>): ChatWorkflowRef | null {
  const target = record(data.target_ref) ? data.target_ref : null;
  const targetId = target?.kind === "workflow" ? text(target.id) : null;
  const resourceId = data.resource_kind === "workflow" ? text(data.resource_id) : null;
  const id = targetId ?? resourceId ?? text(data.workflow_id);
  if (!id) return null;
  const label =
    (target?.kind === "workflow" ? (text(target.slug) ?? text(target.name)) : null) ??
    text(data.slug) ??
    text(data.name);
  return { id, label };
}

export function chatSensitivePreview(tool: ToolPart): ChatSensitivePreview | null {
  const data = dryRunData(tool);
  const summary = data && record(data.schema_only_preview) ? data.schema_only_preview : null;
  if (!data || !summary || summary.mode !== "schema_only" || !record(summary.counts)) return null;
  const steps = count(summary.counts.steps);
  const expressions = count(summary.counts.expressions);
  const compileErrors = count(summary.counts.compile_errors);
  if (steps === null || expressions === null || compileErrors === null) return null;
  const stage = PREVIEW_STAGES.find((value) => value === summary.verification_stage);
  return {
    passed: summary.status === "passed" && compileErrors === 0,
    stage: stage ?? "schema_only",
    steps,
    expressions,
    compileErrors,
    requestsHeld: summary.requests === "held",
    saveRequired: data.save_required === true,
    workflow: workflowRefOf(data),
  };
}

export function chatJudgeFindings(tool: ToolPart): ChatJudgeFindings | null {
  const data = dryRunData(tool);
  const judge = data && record(data.judge) ? data.judge : null;
  if (!data || !judge || (judge.verdict !== "partial" && judge.verdict !== "failed")) return null;
  const missing = Array.isArray(judge.missing)
    ? judge.missing.flatMap((entry) => {
        const value = text(entry);
        return value ? [value] : [];
      })
    : [];
  if (missing.length === 0) return null;
  return {
    verdict: judge.verdict,
    reason: text(judge.reason) ?? "",
    missing,
    workflow: workflowRefOf(data),
  };
}

export interface ChatInstruction {
  message: string;
  references: ConversationReference[];
}

function mention(workflow: ChatWorkflowRef | null): ConversationReference | null {
  if (!workflow?.label || !isMentionableLabel(workflow.label)) return null;
  return { type: "workflow", id: workflow.id, label: workflow.label };
}

export function workflowMention(workflow: ChatWorkflowRef | null): string | null {
  const reference = mention(workflow);
  return reference ? mentionTokenText(reference) : null;
}

export function findingsInstruction(
  t: Translate,
  workflow: ChatWorkflowRef | null,
  findings: readonly string[],
): ChatInstruction {
  const reference = mention(workflow);
  const list = findings.map((finding) => `- ${finding}`).join("\n");
  const message = reference
    ? t(findings.length === 1 ? "chat.findings.fixOneIn" : "chat.findings.fixAllIn", {
        workflow: mentionTokenText(reference),
        findings: list,
      })
    : t(findings.length === 1 ? "chat.findings.fixOne" : "chat.findings.fixAll", {
        findings: list,
      });
  return { message, references: reference ? [reference] : [] };
}

export function openFindings(
  missing: readonly string[],
  states: Readonly<Record<number, FindingState>>,
): number[] {
  return missing.flatMap((_, index) => ((states[index] ?? "open") === "open" ? [index] : []));
}

export function latestDryRunCallId(
  messages: readonly { parts: readonly unknown[] }[],
): string | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m]?.parts ?? [];
    for (let p = parts.length - 1; p >= 0; p--) {
      const tool = asToolPart(parts[p]);
      if (tool && toolNameOf(tool) === "dry_run_workflow") return tool.toolCallId;
    }
  }
  return null;
}

interface ChatToolCallRecord {
  id: string;
  tool: string;
  output?: unknown;
  created_at: string;
}

function resultData(output: unknown): Record<string, unknown> | null {
  if (!record(output) || output.ok === false) return null;
  return record(output.data) ? output.data : output;
}

const SENSITIVE_SAVE_VERIFICATIONS = new Set<unknown>(["schema_only", "metadata_only"]);

function sensitiveSaveRef(call: ChatToolCallRecord): ChatWorkflowRef | null {
  if (call.tool !== "save_workflow_draft") return null;
  const data = resultData(call.output);
  return data && SENSITIVE_SAVE_VERIFICATIONS.has(data.runtime_verification)
    ? workflowRefOf(data)
    : null;
}

export function savedSensitivePreviews(
  calls: readonly ChatToolCallRecord[],
): ReadonlyMap<string, ChatWorkflowRef> {
  const saved = new Map<string, ChatWorkflowRef>();
  const previews: { id: string; workflowId: string | null }[] = [];
  const ordered = [...calls].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const call of ordered) {
    if (call.tool === "dry_run_workflow") {
      const data = resultData(call.output);
      previews.push({ id: call.id, workflowId: data ? (workflowRefOf(data)?.id ?? null) : null });
      continue;
    }
    const workflow = sensitiveSaveRef(call);
    if (!workflow) continue;
    for (let index = previews.length - 1; index >= 0; index--) {
      const preview = previews[index];
      if (preview && (preview.workflowId === null || preview.workflowId === workflow.id)) {
        saved.set(preview.id, workflow);
        break;
      }
    }
  }
  return saved;
}
